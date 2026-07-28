#!/usr/bin/env node

import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync
} from "node:fs"
import {dirname, isAbsolute, join, relative} from "node:path"
import {fileURLToPath} from "node:url"
import {
  CommandFailure,
  CommandRunner,
  isMain,
  outputLines,
  runMain
} from "./hermes-command.js"

const SOURCE_PREFIX = "/opt/hermes-dind-shared/worktrees/snapreq/"

/**
 * Owns the two private, narrowly mounted helper-container operations.
 */
export class HermesSmokeCheckoutHelper {
  /**
   * @param {{
   *   destination?: string,
   *   environment?: NodeJS.ProcessEnv,
   *   fileSystem?: {
   *     chmodSync: typeof chmodSync,
   *     chownSync: typeof chownSync,
   *     lstatSync: typeof lstatSync,
   *     readdirSync: typeof readdirSync,
   *     realpathSync: typeof realpathSync,
   *     rmdirSync: typeof rmdirSync,
   *     statSync: typeof statSync,
   *     unlinkSync: typeof unlinkSync
   *   },
   *   getgid?: () => number,
   *   getuid?: () => number,
   *   mountInfoReader?: () => string
   * }} [options] - Injectable helper boundaries.
   */
  constructor(options = {}) {
    this.destination = options.destination || "/destination"
    this.environment = options.environment || process.env
    this.fileSystem = options.fileSystem || {
      chmodSync,
      chownSync,
      lstatSync,
      readdirSync,
      realpathSync,
      rmdirSync,
      statSync,
      unlinkSync
    }
    this.getgid = options.getgid || (() => process.getgid?.() ?? -1)
    this.getuid = options.getuid || (() => process.getuid?.() ?? -1)
    this.mountInfoReader = options.mountInfoReader ||
      (() => readFileSync("/proc/self/mountinfo", "utf8"))
  }

  /**
   * Rejects an invalid helper invocation or filesystem boundary.
   * @param {string} message - Safe error message.
   * @returns {never}
   */
  fail(message) {
    throw new CommandFailure(message, {status: 2})
  }

  /**
   * Requires the exact private environment marker and mode.
   * @param {string} expectedMode - Expected helper mode.
   */
  validateMarker(expectedMode) {
    if (
      this.environment.HERMES_SMOKE_HELPER !== "1" ||
      this.environment.HERMES_SMOKE_HELPER_MODE !== expectedMode
    ) {
      this.fail("private Hermes smoke helper marker or mode mismatch")
    }
  }

  /**
   * Requires the helper's exact runtime uid/gid.
   * @param {number} uid - Expected uid.
   * @param {number} gid - Expected gid.
   */
  validateIdentity(uid, gid) {
    if (this.getuid() !== uid || this.getgid() !== gid) {
      this.fail(`private Hermes smoke helper must run as uid/gid ${uid}:${gid}`)
    }
  }

  /**
   * Requires one canonical, non-symlink destination directory.
   * @returns {import("node:fs").Stats} - Destination lstat result.
   */
  validateDestination() {
    let linkStats
    try {
      linkStats = this.fileSystem.lstatSync(this.destination)
    } catch {
      this.fail("private Hermes smoke helper destination is missing")
    }
    if (!linkStats.isDirectory() || linkStats.isSymbolicLink()) {
      this.fail("private Hermes smoke helper destination is invalid")
    }
    if (this.fileSystem.realpathSync(this.destination) !== this.destination) {
      this.fail("private Hermes smoke helper destination is not canonical")
    }
    return linkStats
  }

  /**
   * Decodes one mountinfo path field and rejects malformed escaping.
   * @param {string} field - Encoded mountinfo field.
   * @returns {string} - Decoded absolute path.
   */
  decodeMountInfoPath(field) {
    if (/\\(?![0-7]{3})/.test(field)) this.fail("malformed mountinfo path escaping")
    const decoded = field.replace(/\\([0-7]{3})/g, (escape, octal) => {
      const code = Number.parseInt(octal, 8)
      if (!Number.isInteger(code) || code === 0) this.fail("malformed mountinfo path escaping")
      return String.fromCharCode(code)
    })
    if (!isAbsolute(decoded)) this.fail("mountinfo contains a non-absolute mount point")
    return decoded
  }

  /**
   * Parses checked mountinfo output.
   * @returns {string[]} - Absolute mount points.
   */
  readMountPoints() {
    let mountInfo
    try {
      mountInfo = this.mountInfoReader()
    } catch {
      this.fail("unable to read mountinfo before checkout cleanup")
    }
    if (typeof mountInfo !== "string" || mountInfo.length === 0) {
      this.fail("mountinfo is empty before checkout cleanup")
    }

    const lines = mountInfo.split("\n").filter(Boolean)
    if (lines.length === 0) this.fail("mountinfo is empty before checkout cleanup")
    return lines.map((line) => {
      const fields = line.split(" ")
      const separator = fields.indexOf("-")
      if (
        separator < 6 ||
        separator + 3 >= fields.length ||
        !/^[0-9]+$/.test(fields[0] || "") ||
        !/^[0-9]+$/.test(fields[1] || "") ||
        !/^[0-9]+:[0-9]+$/.test(fields[2] || "") ||
        !isAbsolute(this.decodeMountInfoPath(fields[3] || ""))
      ) {
        this.fail("malformed mountinfo before checkout cleanup")
      }
      return this.decodeMountInfoPath(fields[4] || "")
    })
  }

  /**
   * Rejects every mount point strictly below the destination.
   */
  assertNoNestedMounts() {
    for (const mountPoint of this.readMountPoints()) {
      const relativePath = relative(this.destination, mountPoint)
      if (
        relativePath &&
        relativePath !== ".." &&
        !relativePath.startsWith("../") &&
        !isAbsolute(relativePath)
      ) {
        this.fail(`nested mount detected below ${this.destination}`)
      }
    }
  }

  /**
   * Preflights a tree without deleting and rejects cross-device traversal.
   * @param {string} entryPath - Entry to inspect.
   * @param {number} rootDevice - Destination device id.
   */
  validateTreeDevice(entryPath, rootDevice) {
    const stats = this.fileSystem.lstatSync(entryPath)
    if (stats.dev !== rootDevice) this.fail("nested mount detected during checkout cleanup")
    if (!stats.isDirectory() || stats.isSymbolicLink()) return
    for (const entry of this.fileSystem.readdirSync(entryPath)) {
      this.validateTreeDevice(join(entryPath, entry), rootDevice)
    }
  }

  /**
   * Removes one already-preflighted entry without following symlinks.
   * @param {string} entryPath - Entry to remove.
   * @param {number} rootDevice - Destination device id.
   */
  removeEntry(entryPath, rootDevice) {
    const stats = this.fileSystem.lstatSync(entryPath)
    if (stats.dev !== rootDevice) this.fail("nested mount detected during checkout cleanup")
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const entry of this.fileSystem.readdirSync(entryPath)) {
        this.removeEntry(join(entryPath, entry), rootDevice)
      }
      this.fileSystem.rmdirSync(entryPath)
      return
    }
    this.fileSystem.unlinkSync(entryPath)
  }

  /**
   * Gives one exact empty destination uid/gid 1000 and mode 0755.
   */
  initializeDestinationOwnership() {
    this.validateMarker("destination-ownership")
    this.validateIdentity(0, 0)
    this.validateDestination()
    if (this.fileSystem.readdirSync(this.destination).length !== 0) {
      this.fail("destination is not empty before ownership initialization")
    }
    this.fileSystem.chownSync(this.destination, 1000, 1000)
    this.fileSystem.chmodSync(this.destination, 0o755)
    const stats = this.fileSystem.statSync(this.destination)
    if (stats.uid !== 1000 || stats.gid !== 1000 || (stats.mode & 0o777) !== 0o755) {
      this.fail("destination ownership initialization failed")
    }
  }

  /**
   * Removes checkout contents only after mount and device preflight.
   */
  cleanupCheckout() {
    this.validateMarker("checkout-cleanup")
    this.validateIdentity(1000, 1000)
    const rootStats = this.validateDestination()
    this.assertNoNestedMounts()
    const entries = this.fileSystem.readdirSync(this.destination)
    for (const entry of entries) {
      this.validateTreeDevice(join(this.destination, entry), rootStats.dev)
    }
    this.assertNoNestedMounts()
    for (const entry of entries) {
      this.removeEntry(join(this.destination, entry), rootStats.dev)
    }
    if (this.fileSystem.readdirSync(this.destination).length !== 0) {
      this.fail("destination cleanup incomplete")
    }
  }

  /**
   * Runs one exact private helper command.
   * @param {string[]} arguments_ - Private command and no additional arguments.
   */
  main(arguments_) {
    if (arguments_.length !== 1) this.fail("private Hermes smoke helper requires one exact command")
    switch (arguments_[0]) {
      case "_helper-destination-ownership":
        this.initializeDestinationOwnership()
        break
      case "_helper-checkout-cleanup":
        this.cleanupCheckout()
        break
      default:
        this.fail("unknown private Hermes smoke helper command")
    }
  }
}

/**
 * Owns fail-closed Docker queries shared by smoke allocation and cleanup.
 */
export class HermesSmokeSafety {
  /**
   * @param {{runner?: {capture: (command: string, arguments_: string[], options?: object) => string}}} [options] - Query boundary.
   */
  constructor(options = {}) {
    this.runner = options.runner || new CommandRunner()
  }

  /**
   * Rejects an unsafe smoke state.
   * @param {string} message - Safe error message.
   * @returns {never}
   */
  fail(message) {
    throw new CommandFailure(message, {status: 2})
  }

  /**
   * Proves that no existing resource belongs to the candidate task project.
   * @param {string} projectName - Exact Compose project name.
   */
  assertProjectResourcesAbsent(projectName) {
    const containerIds = outputLines(this.runner.capture("docker", [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`
    ]))
    if (containerIds.length !== 0) this.fail(`containers already exist for ${projectName}`)

    const volumeNames = new Set(outputLines(this.runner.capture(
      "docker",
      ["volume", "ls", "--format", "{{.Name}}"]
    )))
    for (const purpose of ["node_modules", "npm_cache", "codex_home"]) {
      const volumeName = `${projectName}_${purpose}`
      if (volumeNames.has(volumeName)) this.fail(`volume already exists for ${projectName}: ${volumeName}`)
    }
    const labeledVolumes = outputLines(this.runner.capture("docker", [
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=io.snapreq.hermes.project=${projectName}`
    ]))
    if (labeledVolumes.length !== 0) this.fail(`project-labeled volumes already exist for ${projectName}`)

    const networkNames = new Set(outputLines(this.runner.capture(
      "docker",
      ["network", "ls", "--format", "{{.Name}}"]
    )))
    if (networkNames.has(`${projectName}_default`)) {
      this.fail(`default network already exists for ${projectName}`)
    }
    const labeledNetworks = outputLines(this.runner.capture("docker", [
      "network",
      "ls",
      "--quiet",
      "--filter",
      `label=io.snapreq.hermes.project=${projectName}`
    ]))
    if (labeledNetworks.length !== 0) this.fail(`project-labeled networks already exist for ${projectName}`)

    const imageNames = new Set(outputLines(this.runner.capture(
      "docker",
      ["image", "ls", "--format", "{{.Repository}}"]
    )))
    if (imageNames.has(`${projectName}-dev`)) this.fail(`development image already exists for ${projectName}`)
    const labeledImages = outputLines(this.runner.capture("docker", [
      "image",
      "ls",
      "--quiet",
      "--filter",
      `label=io.snapreq.hermes.project=${projectName}`
    ]))
    if (labeledImages.length !== 0) this.fail(`project-labeled images already exist for ${projectName}`)
  }

  /**
   * Captures every Docker query before proving no exact path reference exists.
   * @param {string} sourcePath - Exact checkout path.
   */
  assertNoContainerPathReferences(sourcePath) {
    const containerIds = outputLines(this.runner.capture(
      "docker",
      ["container", "ls", "--all", "--quiet"]
    ))
    for (const containerId of containerIds) {
      const mountSources = outputLines(this.runner.capture("docker", [
        "container",
        "inspect",
        "--format",
        "{{range .Mounts}}{{println .Source}}{{end}}",
        containerId
      ]))
      if (mountSources.includes(sourcePath)) {
        this.fail(`container ${containerId} still references ${sourcePath}`)
      }
    }
  }
}

/**
 * Owns the two-stack Hermes acceptance state machine.
 */
export class HermesSmoke extends HermesSmokeSafety {
  /**
   * @param {{
   *   bootstrapImage?: string,
   *   environment?: NodeJS.ProcessEnv,
   *   runner?: CommandRunner | {capture: Function, run: Function, findExecutable?: Function},
   *   scriptPath?: string,
   *   sourceRepo?: string
   * }} [options] - Runtime boundaries.
   */
  constructor(options = {}) {
    const environment = options.environment || process.env
    const runner = options.runner || new CommandRunner({environment})
    super({runner})
    this.environment = environment
    this.scriptPath = options.scriptPath || fileURLToPath(import.meta.url)
    this.sourceRepo = options.sourceRepo || realpathSync(join(dirname(this.scriptPath), ".."))
    this.sourceTask = this.sourceRepo.startsWith(SOURCE_PREFIX)
      ? this.sourceRepo.slice(SOURCE_PREFIX.length)
      : ""
    this.sourceProject = `snapreq-${this.sourceTask}`
    this.bootstrapImage = options.bootstrapImage || `${this.sourceProject}-dev`
    this.validator = join(this.sourceRepo, "scripts", "hermes-compose.js")
    /** @type {{created: boolean, stackTouched: boolean, sha: string, path: string, branch: string, project: string}[]} */
    this.stacks = []
    this.baseHead = ""
    this.baseOrigin = ""
  }

  /**
   * Validates one exact task path below the shared source prefix.
   * @param {string} taskPath - Candidate task path.
   */
  validateTaskPath(taskPath) {
    const task = taskPath.startsWith(SOURCE_PREFIX) ? taskPath.slice(SOURCE_PREFIX.length) : ""
    if (!task || task.includes("/") || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(task)) {
      this.fail("refusing non-task path")
    }
  }

  /**
   * Reports any filesystem entry, including a dangling symbolic link.
   * @param {string} entryPath - Exact path to query.
   * @returns {boolean} - True when lstat resolves an entry.
   */
  pathEntryExists(entryPath) {
    try {
      lstatSync(entryPath)
      return true
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return false
      throw error
    }
  }

  /**
   * Builds the root ownership-helper Docker arguments.
   * @param {string} destinationPath - Exact empty task directory.
   * @returns {string[]} - Docker argument vector.
   */
  destinationOwnershipArguments(destinationPath) {
    return [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "FOWNER",
      "--security-opt",
      "no-new-privileges:true",
      "--env",
      "HERMES_SMOKE_HELPER=1",
      "--env",
      "HERMES_SMOKE_HELPER_MODE=destination-ownership",
      "--mount",
      `type=bind,src=${this.sourceRepo},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${destinationPath},dst=/destination`,
      this.bootstrapImage,
      "node",
      "/source/scripts/hermes-smoke.js",
      "_helper-destination-ownership"
    ]
  }

  /**
   * Builds the non-root checkout cleanup Docker arguments.
   * @param {string} sourcePath - Exact checkout path.
   * @returns {string[]} - Docker argument vector.
   */
  checkoutCleanupArguments(sourcePath) {
    return [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--env",
      "HERMES_SMOKE_HELPER=1",
      "--env",
      "HERMES_SMOKE_HELPER_MODE=checkout-cleanup",
      "--mount",
      `type=bind,src=${this.sourceRepo},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${sourcePath},dst=/destination`,
      this.bootstrapImage,
      "node",
      "/source/scripts/hermes-smoke.js",
      "_helper-checkout-cleanup"
    ]
  }

  /**
   * Builds the narrow checkout bootstrap Docker arguments.
   * @param {string} destinationPath - Exact destination checkout.
   * @param {string} branchName - Smoke branch.
   * @param {string} projectName - Smoke Compose project.
   * @returns {string[]} - Docker argument vector.
   */
  bootstrapArguments(destinationPath, branchName, projectName) {
    return [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000",
      "--env",
      "HOME=/tmp",
      "--env",
      "GIT_CONFIG_NOSYSTEM=1",
      "--env",
      "GIT_OPTIONAL_LOCKS=0",
      "--env",
      "HERMES_SMOKE_BOOTSTRAP=1",
      "--mount",
      `type=bind,src=${this.sourceRepo},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${destinationPath},dst=/destination`,
      this.bootstrapImage,
      "node",
      "/source/scripts/hermes-smoke-bootstrap.js",
      branchName,
      projectName
    ]
  }

  /**
   * Returns a stack-specific lifecycle environment.
   * @param {{path: string, project: string}} stack - Smoke stack.
   * @param {NodeJS.ProcessEnv} [extraEnvironment] - Extra exact values.
   * @returns {NodeJS.ProcessEnv} - Child environment.
   */
  stackEnvironment(stack, extraEnvironment = {}) {
    return {
      ...this.environment,
      SNAPREQ_SOURCE_PATH: stack.path,
      SNAPREQ_COMPOSE_PROJECT: stack.project,
      ...extraEnvironment
    }
  }

  /**
   * Runs a stack lifecycle command with inherited streams.
   * @param {{path: string, project: string}} stack - Smoke stack.
   * @param {string[]} arguments_ - Lifecycle arguments.
   * @param {NodeJS.ProcessEnv} [extraEnvironment] - Extra exact values.
   * @returns {Promise<void>}
   */
  async runHelper(stack, arguments_, extraEnvironment = {}) {
    await this.runner.run(join(stack.path, "scripts", "hermes-compose.js"), arguments_, {
      env: this.stackEnvironment(stack, extraEnvironment)
    })
  }

  /**
   * Captures a stack lifecycle query.
   * @param {{path: string, project: string}} stack - Smoke stack.
   * @param {string[]} arguments_ - Lifecycle arguments.
   * @returns {string} - Complete stdout.
   */
  captureHelper(stack, arguments_) {
    return this.runner.capture(join(stack.path, "scripts", "hermes-compose.js"), arguments_, {
      env: this.stackEnvironment(stack)
    })
  }

  /**
   * Purges one exact stack.
   * @param {{path: string, project: string}} stack - Smoke stack.
   * @returns {Promise<void>}
   */
  async purgeStack(stack) {
    await this.runHelper(stack, ["purge"], {
      SNAPREQ_PURGE_PROJECT: stack.project
    })
  }

  /**
   * Creates and initializes one exact empty destination.
   * @param {{created: boolean, path: string}} stack - Smoke stack state.
   * @returns {Promise<void>}
   */
  async createEmptyDestination(stack) {
    this.validateTaskPath(stack.path)
    mkdirSync(stack.path, {mode: 0o755})
    stack.created = true
    if (realpathSync(stack.path) !== stack.path) this.fail("destination path must be canonical")
    if (readdirSync(stack.path).length !== 0) {
      this.fail("destination must be empty before ownership initialization")
    }
    await this.runner.run("docker", this.destinationOwnershipArguments(stack.path))
    const stats = statSync(stack.path)
    if (stats.uid !== 1000 || stats.gid !== 1000) {
      this.fail("destination ownership helper did not set 1000:1000")
    }
    if ((stats.mode & 0o777) !== 0o755) this.fail("destination ownership helper did not set mode 0755")
    if (readdirSync(stack.path).length !== 0) this.fail("destination must be empty")
  }

  /**
   * Removes an exact empty incomplete destination without a recursive host delete.
   * @param {{path: string}} stack - Smoke stack.
   */
  removeEmptyDestination(stack) {
    this.validateTaskPath(stack.path)
    this.assertNoContainerPathReferences(stack.path)
    const stats = lstatSync(stack.path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) this.fail("refusing to remove an invalid destination")
    if (readdirSync(stack.path).length !== 0) {
      this.fail("refusing to remove a nonempty incomplete destination")
    }
    rmdirSync(stack.path)
  }

  /**
   * Removes one validated checkout through the non-root, mount-aware helper.
   * @param {{path: string, branch: string, sha: string}} stack - Smoke stack.
   * @returns {Promise<void>}
   */
  async removeCheckout(stack) {
    this.validateTaskPath(stack.path)
    const stats = lstatSync(stack.path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) this.fail("refusing to remove an invalid checkout path")
    if (realpathSync(stack.path) !== stack.path) this.fail("refusing to remove a non-canonical checkout path")
    this.assertNoContainerPathReferences(stack.path)
    const gitStats = lstatSync(join(stack.path, ".git"))
    if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) {
      this.fail("refusing to remove a checkout without its own .git directory")
    }
    const identity = this.runner.capture(this.validator, ["_read-checkout-identity", stack.path])
    const identityValues = Object.fromEntries(
      outputLines(identity).map((line) => {
        const separator = line.indexOf("=")
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
    )
    const headReference = readFileSync(join(stack.path, ".git", "HEAD"), "utf8")
      .split("\n")[0]
      .replace(/\r$/, "")
    if (headReference !== `ref: refs/heads/${stack.branch}`) {
      this.fail("refusing to remove checkout on an unexpected branch")
    }
    if (identityValues.head !== stack.sha) this.fail("refusing to remove checkout at an unexpected revision")
    if (identityValues.origin !== this.baseOrigin) {
      this.fail("refusing to remove checkout with an unexpected origin")
    }
    await this.runner.run("docker", this.checkoutCleanupArguments(stack.path))
    if (readdirSync(stack.path).length !== 0) this.fail("checkout cleanup helper left content behind")
    rmdirSync(stack.path)
  }

  /**
   * Parses the strict bootstrap evidence line.
   * @param {string} output - Bootstrap stdout.
   * @returns {{head: string, markerChecksum: string, baseHead: string, origin: string}} - Evidence.
   */
  parseBootstrapResult(output) {
    const match = output.trim().match(
      /^head=([0-9a-f]{40}) marker_sha256=([0-9a-f]{64}) base_head=([0-9a-f]{40}) origin=(\S+)$/
    )
    if (!match) this.fail("bootstrap returned malformed identity evidence")
    return {
      head: match[1],
      markerChecksum: match[2],
      baseHead: match[3],
      origin: match[4]
    }
  }

  /**
   * Proves one running stack's exact identity and isolation.
   * @param {{path: string, project: string, sha: string, markerChecksum: string}} stack - Smoke stack.
   * @returns {Promise<string>} - Container ID.
   */
  async assertStack(stack) {
    await this.runHelper(stack, ["proof"])
    await this.runHelper(stack, [
      "exec",
      "--no-tty",
      "node",
      "scripts/hermes-compose.js",
      "_assert-smoke-stack",
      stack.project,
      stack.sha,
      stack.markerChecksum
    ])

    const containerId = this.captureHelper(stack, ["container-id"]).trim()
    const projectLabel = this.runner.capture("docker", [
      "inspect",
      "--format",
      "{{index .Config.Labels \"com.docker.compose.project\"}}",
      containerId
    ]).trim()
    const serviceLabel = this.runner.capture("docker", [
      "inspect",
      "--format",
      "{{index .Config.Labels \"com.docker.compose.service\"}}",
      containerId
    ]).trim()
    const dependencyVolume = this.runner.capture("docker", [
      "inspect",
      "--format",
      "{{range .Mounts}}{{if eq .Destination \"/workspace/node_modules\"}}{{.Name}}{{end}}{{end}}",
      containerId
    ]).trim()
    const networks = outputLines(this.runner.capture("docker", [
      "inspect",
      "--format",
      "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}",
      containerId
    ]))
    if (projectLabel !== stack.project) this.fail(`container project label mismatch for ${stack.project}`)
    if (serviceLabel !== "dev") this.fail(`container service label mismatch for ${stack.project}`)
    if (dependencyVolume !== `${stack.project}_node_modules`) {
      this.fail(`dependency volume mismatch for ${stack.project}`)
    }
    if (networks.length !== 1 || networks[0] !== `${stack.project}_default`) {
      this.fail(`network identity mismatch for ${stack.project}`)
    }
    const volumeProject = this.runner.capture("docker", [
      "volume",
      "inspect",
      "--format",
      "{{index .Labels \"com.docker.compose.project\"}}",
      dependencyVolume
    ]).trim()
    const networkProject = this.runner.capture("docker", [
      "network",
      "inspect",
      "--format",
      "{{index .Labels \"com.docker.compose.project\"}}",
      `${stack.project}_default`
    ]).trim()
    if (volumeProject !== stack.project) this.fail(`dependency volume project label mismatch for ${stack.project}`)
    if (networkProject !== stack.project) this.fail(`network project label mismatch for ${stack.project}`)
    process.stdout.write(
      `identity project=${stack.project} container=${containerId} network=${networks[0]} ` +
      `dependency-volume=${dependencyVolume} head=${stack.sha} marker-sha256=${stack.markerChecksum}\n`
    )
    return containerId
  }

  /**
   * Preflights the source task, auth source, candidate projects, and paths.
   * @returns {{stackA: object, stackB: object}} - Candidate stack states.
   */
  preflight() {
    if (!this.sourceRepo.startsWith(SOURCE_PREFIX) || !this.sourceTask || this.sourceTask.includes("/")) {
      this.fail(`run from an exact Hermes task worktree below ${SOURCE_PREFIX}`)
    }
    const validatorStats = statSync(this.validator)
    if (!validatorStats.isFile() || (validatorStats.mode & 0o111) === 0) {
      this.fail("Hermes lifecycle helper is not executable")
    }
    this.runner.findExecutable?.("docker", this.environment)
    this.runner.capture("docker", ["compose", "version"])
    this.runner.findExecutable?.(this.environment.THREADWIRE_BIN || "threadwire", this.environment)
    const authVolume = this.environment.SNAPREQ_CODEX_AUTH_VOLUME || ""
    if (!authVolume) this.fail("SNAPREQ_CODEX_AUTH_VOLUME is required")
    if (!this.environment.THREADWIRE_TARGET) this.fail("THREADWIRE_TARGET is required")
    this.runner.capture(this.validator, ["_validate-auth-volume-name", authVolume])
    const inspectedAuthVolume = this.runner.capture(
      "docker",
      ["volume", "inspect", "--format", "{{.Name}}", authVolume],
      {quiet: true}
    ).trim()
    if (inspectedAuthVolume !== authVolume) {
      this.fail("SNAPREQ_CODEX_AUTH_VOLUME does not exist in the Hermes Docker daemon")
    }
    this.runner.capture(this.validator, ["_validate-project-pair", this.sourceTask, this.sourceProject])
    this.runner.capture(this.validator, ["validate"], {
      env: {
        ...this.environment,
        SNAPREQ_SOURCE_PATH: this.sourceRepo,
        SNAPREQ_COMPOSE_PROJECT: this.sourceProject
      }
    })
    const imageType = this.runner.capture("docker", [
      "image",
      "inspect",
      "--format",
      "{{index .Config.Labels \"io.snapreq.hermes.image\"}}",
      this.bootstrapImage
    ], {quiet: true}).trim()
    const imageProject = this.runner.capture("docker", [
      "image",
      "inspect",
      "--format",
      "{{index .Config.Labels \"io.snapreq.hermes.project\"}}",
      this.bootstrapImage
    ], {quiet: true}).trim()
    if (imageType !== "dev" || imageProject !== this.sourceProject) {
      this.fail("build the validated source task image before running the smoke")
    }

    const taskA = this.environment.SNAPREQ_SMOKE_TASK_A || ""
    const taskB = this.environment.SNAPREQ_SMOKE_TASK_B || ""
    if (!taskA || !taskB) this.fail("SNAPREQ_SMOKE_TASK_A and SNAPREQ_SMOKE_TASK_B are required")
    if (taskA === taskB) this.fail("smoke task names must be distinct")
    const projectA = `snapreq-${taskA}`
    const projectB = `snapreq-${taskB}`
    this.runner.capture(this.validator, ["_validate-project-pair", taskA, projectA])
    this.runner.capture(this.validator, ["_validate-project-pair", taskB, projectB])
    const stackA = {
      branch: `hermes-smoke/${taskA}`,
      created: false,
      markerChecksum: "",
      path: `${SOURCE_PREFIX}${taskA}`,
      project: projectA,
      sha: "",
      stackTouched: false
    }
    const stackB = {
      branch: `hermes-smoke/${taskB}`,
      created: false,
      markerChecksum: "",
      path: `${SOURCE_PREFIX}${taskB}`,
      project: projectB,
      sha: "",
      stackTouched: false
    }
    for (const stack of [stackA, stackB]) {
      if (this.pathEntryExists(stack.path)) this.fail(`smoke path already exists: ${stack.path}`)
      this.assertProjectResourcesAbsent(stack.project)
    }
    this.stacks = [stackA, stackB]
    return {stackA, stackB}
  }

  /**
   * Best-effort exact cleanup after a failed smoke.
   * @returns {Promise<void>}
   */
  async emergencyCleanup() {
    for (const stack of this.stacks) {
      if (stack.stackTouched && existsSync(join(stack.path, "scripts", "hermes-compose.js"))) {
        try {
          await this.runHelper(stack, ["down"])
          await this.purgeStack(stack)
          stack.stackTouched = false
        } catch {
          process.stderr.write(
            `hermes-smoke: preserving ${stack.path} because exact Compose cleanup failed\n`
          )
        }
      }
    }
    for (const stack of this.stacks) {
      if (!stack.created || stack.stackTouched || !existsSync(stack.path)) continue
      try {
        if (stack.sha) await this.removeCheckout(stack)
        else this.removeEmptyDestination(stack)
      } catch {
        // Preserve any path that cannot pass the exact cleanup boundary.
      }
    }
  }

  /**
   * Runs the complete two-stack acceptance workflow.
   * @returns {Promise<void>}
   */
  async workflow() {
    const {stackA, stackB} = this.preflight()
    await this.createEmptyDestination(stackA)
    const bootstrapA = this.parseBootstrapResult(this.runner.capture(
      "docker",
      this.bootstrapArguments(stackA.path, stackA.branch, stackA.project),
      {forwardStderr: true}
    ))
    Object.assign(stackA, {sha: bootstrapA.head, markerChecksum: bootstrapA.markerChecksum})
    this.baseHead = bootstrapA.baseHead
    this.baseOrigin = bootstrapA.origin

    await this.createEmptyDestination(stackB)
    const bootstrapB = this.parseBootstrapResult(this.runner.capture(
      "docker",
      this.bootstrapArguments(stackB.path, stackB.branch, stackB.project),
      {forwardStderr: true}
    ))
    Object.assign(stackB, {sha: bootstrapB.head, markerChecksum: bootstrapB.markerChecksum})
    if (stackA.sha === stackB.sha) this.fail("smoke commits are not distinguishable")
    if (stackA.markerChecksum === stackB.markerChecksum) this.fail("smoke marker checksums are not distinguishable")
    if (bootstrapB.baseHead !== this.baseHead || bootstrapB.origin !== this.baseOrigin) {
      this.fail("bootstrap containers did not use the same source identity")
    }
    process.stdout.write(
      `stack-a branch=${stackA.branch} head=${stackA.sha} marker-sha256=${stackA.markerChecksum}\n`
    )
    process.stdout.write(
      `stack-b branch=${stackB.branch} head=${stackB.sha} marker-sha256=${stackB.markerChecksum}\n`
    )

    for (const stack of this.stacks) await this.runHelper(stack, ["validate"])
    for (const stack of this.stacks) this.captureHelper(stack, ["config"])
    stackA.stackTouched = true
    await this.runHelper(stackA, ["build", "--pull", "--no-cache"])
    stackB.stackTouched = true
    await this.runHelper(stackB, ["build", "--pull", "--no-cache"])
    for (const stack of this.stacks) await this.runHelper(stack, ["init-codex"])
    for (const stack of this.stacks) await this.runHelper(stack, ["up"])
    for (const stack of this.stacks) await this.runHelper(stack, ["exec", "--no-tty", "npm", "ci"])
    for (const stack of this.stacks) {
      await this.runHelper(stack, ["exec", "--no-tty", "npm", "run", "all-checks"])
    }

    await this.assertStack(stackA)
    await this.assertStack(stackB)
    const containerBBefore = this.captureHelper(stackB, ["container-id"]).trim()
    const probePrompt =
      "Read-only acceptance probe. Do not edit files. Run only: pwd; git rev-parse HEAD; " +
      "node -e 'const p=require(\"./package.json\"); console.log(p.name, p.version)'. Report those results."
    for (const stack of this.stacks) {
      await this.runHelper(stack, ["threadwire", "--prompt", probePrompt])
    }
    await this.assertStack(stackA)
    await this.assertStack(stackB)

    await this.runHelper(stackA, ["down"])
    const stackAContainers = outputLines(this.runner.capture("docker", [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${stackA.project}`
    ]))
    if (stackAContainers.length !== 0) this.fail("stack A still has containers after down")
    const networkNamesAfterA = new Set(outputLines(this.runner.capture(
      "docker",
      ["network", "ls", "--format", "{{.Name}}"]
    )))
    if (networkNamesAfterA.has(`${stackA.project}_default`)) this.fail("stack A network remains after down")

    const containerBAfter = this.captureHelper(stackB, ["container-id"]).trim()
    if (containerBAfter !== containerBBefore) this.fail("stack B container changed when stack A stopped")
    await this.assertStack(stackB)
    process.stdout.write(
      `stack-b-survived stack-a teardown container=${containerBAfter} head=${stackB.sha} ` +
      `marker-sha256=${stackB.markerChecksum}\n`
    )

    await this.runHelper(stackB, ["down"])
    await this.purgeStack(stackA)
    stackA.stackTouched = false
    await this.purgeStack(stackB)
    stackB.stackTouched = false

    const remainingVolumes = new Set(outputLines(this.runner.capture(
      "docker",
      ["volume", "ls", "--format", "{{.Name}}"]
    )))
    const remainingNetworks = new Set(outputLines(this.runner.capture(
      "docker",
      ["network", "ls", "--format", "{{.Name}}"]
    )))
    const remainingImages = new Set(outputLines(this.runner.capture(
      "docker",
      ["image", "ls", "--format", "{{.Repository}}"]
    )))
    for (const stack of this.stacks) {
      const remainingContainers = outputLines(this.runner.capture("docker", [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${stack.project}`
      ]))
      if (remainingContainers.length !== 0) this.fail(`containers remain for ${stack.project} after purge`)
      for (const purpose of ["node_modules", "npm_cache", "codex_home"]) {
        if (remainingVolumes.has(`${stack.project}_${purpose}`)) {
          this.fail(`volume remains after exact purge: ${stack.project}_${purpose}`)
        }
      }
      if (remainingNetworks.has(`${stack.project}_default`)) {
        this.fail(`network remains after exact purge: ${stack.project}_default`)
      }
      if (remainingImages.has(`${stack.project}-dev`)) {
        this.fail(`image remains after exact purge: ${stack.project}-dev`)
      }
    }

    await this.removeCheckout(stackA)
    stackA.created = false
    await this.removeCheckout(stackB)
    stackB.created = false
    process.stdout.write(
      `Hermes two-stack smoke passed and removed only ${stackA.project} and ${stackB.project} resources.\n`
    )
  }

  /**
   * Runs the workflow with exact emergency cleanup on failure.
   * @param {string[]} [arguments_] - Normal smoke accepts no arguments.
   * @returns {Promise<void>}
   */
  async main(arguments_ = []) {
    if (arguments_.length !== 0) this.fail("Hermes smoke takes no arguments")
    try {
      await this.workflow()
    } catch (error) {
      await this.emergencyCleanup()
      throw error
    }
  }
}

if (isMain(import.meta.url)) {
  const arguments_ = process.argv.slice(2)
  if (arguments_[0]?.startsWith("_helper-")) {
    const helper = new HermesSmokeCheckoutHelper()
    await runMain(() => helper.main(arguments_), "hermes-smoke-helper")
  } else {
    const smoke = new HermesSmoke()
    await runMain(() => smoke.main(arguments_), "hermes-smoke")
  }
}
