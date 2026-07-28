#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs"
import {createHash} from "node:crypto"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"
import {
  CommandFailure,
  CommandRunner,
  isMain,
  outputLines,
  runMain
} from "./hermes-command.js"

const EXPECTED_ORIGIN_HTTPS = "https://github.com/kaspernj/snapreq.git"
const EXPECTED_SOURCE_PREFIX = "/opt/hermes-dind-shared/worktrees/snapreq/"
const EXPECTED_UID = 1000
const EXPECTED_GID = 1000

/**
 * Owns the validated Hermes Compose lifecycle.
 */
export class HermesComposeCli {
  /**
   * @param {{
   *   environment?: NodeJS.ProcessEnv,
   *   fileSystem?: {
   *     chmodSync?: typeof chmodSync,
   *     copyFileSync?: typeof copyFileSync,
   *     existsSync?: typeof existsSync,
   *     lstatSync: typeof lstatSync,
   *     readFileSync: typeof readFileSync,
   *     realpathSync: typeof realpathSync,
   *     statSync: typeof statSync
   *   },
   *   runner?: CommandRunner,
   *   scriptPath?: string
   * }} [options] - Injectable runtime boundaries.
   */
  constructor(options = {}) {
    this.environment = options.environment || process.env
    this.fileSystem = options.fileSystem || {
      chmodSync,
      copyFileSync,
      existsSync,
      lstatSync,
      readFileSync,
      realpathSync,
      statSync
    }
    this.runner = options.runner || new CommandRunner({environment: this.environment})
    this.scriptPath = options.scriptPath || fileURLToPath(import.meta.url)
    this.repoDirectory = realpathSync(join(dirname(this.scriptPath), ".."))
    this.composeFile = join(this.repoDirectory, "compose.hermes.yml")
  }

  /**
   * Rejects with a lifecycle usage failure.
   * @param {string} message - Safe error message.
   * @returns {never}
   */
  fail(message) {
    throw new CommandFailure(message, {status: 2})
  }

  /**
   * Validates the exact task/project naming pair.
   * @param {string} taskName - Task suffix.
   * @param {string} projectName - Compose project.
   */
  validateProjectPair(taskName = "", projectName = "") {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(taskName)) {
      this.fail("task must contain only lowercase letters, digits, and internal hyphens")
    }
    if (projectName.length > 63) this.fail("Compose project name exceeds 63 characters")
    if (projectName !== `snapreq-${taskName}`) {
      this.fail("SNAPREQ_COMPOSE_PROJECT must equal snapreq-<task>")
    }
  }

  /**
   * Validates ownership, canonical identity, and self-contained Git metadata.
   * @param {string} checkoutPath - Canonical checkout path.
   */
  validateCheckoutOwnership(checkoutPath = "") {
    let checkout
    let gitDirectory
    try {
      checkout = this.fileSystem.lstatSync(checkoutPath)
      gitDirectory = this.fileSystem.lstatSync(join(checkoutPath, ".git"))
    } catch {
      this.fail("checkout path does not exist")
    }
    if (!checkout.isDirectory()) this.fail("checkout path does not exist")
    if (this.fileSystem.realpathSync(checkoutPath) !== checkoutPath) {
      this.fail("checkout path must be canonical and may not be a symlink")
    }
    if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
      this.fail("source must be a self-contained checkout with its .git directory inside the exact mount")
    }

    for (const checkedPath of [checkoutPath, join(checkoutPath, ".git")]) {
      const stats = this.fileSystem.statSync(checkedPath)
      if (stats.uid !== EXPECTED_UID || stats.gid !== EXPECTED_GID) {
        this.fail(
          `${checkedPath} must be owned by uid/gid 1000:1000 (found ${stats.uid}:${stats.gid})`
        )
      }
      if ((stats.mode & 0o002) !== 0) this.fail(`${checkedPath} may not be world-writable`)
    }
  }

  /**
   * Validates a private Docker auth volume name.
   * @param {string} volumeName - Candidate volume name.
   */
  validateAuthVolumeName(volumeName = "") {
    if (!/^[a-z0-9][a-z0-9_.-]{1,127}$/.test(volumeName)) {
      this.fail("SNAPREQ_CODEX_AUTH_VOLUME must be a 2-128 character lowercase Docker volume name")
    }
  }

  /**
   * Reads the exact origin remote from self-contained Git metadata.
   * @param {string} checkoutPath - Checkout path.
   * @returns {string} - Origin URL.
   */
  readCheckoutOrigin(checkoutPath) {
    const configPath = join(checkoutPath, ".git", "config")
    const configStats = this.fileSystem.lstatSync(configPath)
    if (!configStats.isFile() || configStats.isSymbolicLink()) {
      this.fail("source .git/config must be a regular file inside the exact checkout")
    }

    let inOrigin = false
    for (const rawLine of this.fileSystem.readFileSync(configPath, "utf8").split("\n")) {
      const line = rawLine.replace(/\r$/, "")
      const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/)
      if (section) {
        inOrigin = section[1] === "origin"
        continue
      }
      if (/^\s*\[/.test(line)) {
        inOrigin = false
        continue
      }
      if (!inOrigin) continue
      const url = line.match(/^\s*url\s*=\s*(.+)$/)
      if (url) {
        const origin = url[1]
        if (!origin || /\s/.test(origin)) this.fail("source has no unambiguous origin URL")
        return origin
      }
    }
    this.fail("source has no unambiguous origin URL")
  }

  /**
   * Reads a full SHA-1 from HEAD, loose refs, or packed refs.
   * @param {string} checkoutPath - Checkout path.
   * @returns {string} - Full commit SHA.
   */
  readCheckoutHead(checkoutPath) {
    const gitDirectory = join(checkoutPath, ".git")
    const headPath = join(gitDirectory, "HEAD")
    const headStats = this.fileSystem.lstatSync(headPath)
    if (!headStats.isFile() || headStats.isSymbolicLink()) {
      this.fail("source .git/HEAD must be a regular file inside the exact checkout")
    }
    const headValue = this.fileSystem.readFileSync(headPath, "utf8").split("\n")[0].replace(/\r$/, "")
    let headSha = headValue

    if (headValue.startsWith("ref: ")) {
      const reference = headValue.slice(5)
      if (
        !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(reference) ||
        reference.includes("..") ||
        reference.includes("//") ||
        reference.endsWith("/")
      ) {
        this.fail("source HEAD contains an unsafe branch reference")
      }
      const referencePath = join(gitDirectory, ...reference.split("/"))
      if (this.fileSystem.existsSync?.(referencePath)) {
        const referenceStats = this.fileSystem.lstatSync(referencePath)
        if (!referenceStats.isFile() || referenceStats.isSymbolicLink()) {
          this.fail("source branch reference is unreadable")
        }
        headSha = this.fileSystem.readFileSync(referencePath, "utf8").split("\n")[0].replace(/\r$/, "")
      } else {
        const packedRefsPath = join(gitDirectory, "packed-refs")
        if (!this.fileSystem.existsSync?.(packedRefsPath)) this.fail("source branch reference is missing")
        const packedStats = this.fileSystem.lstatSync(packedRefsPath)
        if (!packedStats.isFile() || packedStats.isSymbolicLink()) {
          this.fail("source packed refs are unreadable")
        }
        const entry = this.fileSystem.readFileSync(packedRefsPath, "utf8")
          .split("\n")
          .find((line) => line.endsWith(` ${reference}`) && /^[0-9a-f]{40}\s/.test(line))
        if (!entry) this.fail("source branch reference is missing")
        headSha = entry.slice(0, 40)
      }
    }
    if (!/^[0-9a-f]{40}$/.test(headSha)) this.fail("source HEAD is not a full SHA-1")
    return headSha
  }

  /**
   * Reads the validated Git identity.
   * @param {string} checkoutPath - Checkout path.
   * @returns {{head: string, origin: string}} - Identity.
   */
  readCheckoutIdentity(checkoutPath) {
    return {
      head: this.readCheckoutHead(checkoutPath),
      origin: this.readCheckoutOrigin(checkoutPath)
    }
  }

  /**
   * Validates the configured exact worktree and Compose project.
   */
  validateSourceAndProject() {
    const sourcePath = this.environment.SNAPREQ_SOURCE_PATH || ""
    const projectName = this.environment.SNAPREQ_COMPOSE_PROJECT || ""
    if (!sourcePath) this.fail("SNAPREQ_SOURCE_PATH is required")
    if (!projectName) this.fail("SNAPREQ_COMPOSE_PROJECT is required")
    if (!sourcePath.startsWith(EXPECTED_SOURCE_PREFIX)) {
      this.fail(`SNAPREQ_SOURCE_PATH must be an exact task checkout below ${EXPECTED_SOURCE_PREFIX}`)
    }

    const taskName = sourcePath.slice(EXPECTED_SOURCE_PREFIX.length)
    this.validateProjectPair(taskName, projectName)
    if (taskName.includes("/")) this.fail("SNAPREQ_SOURCE_PATH must name one task directory, not a nested path")
    const canonicalSource = this.fileSystem.realpathSync(sourcePath)
    if (canonicalSource !== sourcePath) {
      this.fail("SNAPREQ_SOURCE_PATH must already be canonical and may not be a symlink")
    }
    if (canonicalSource !== this.repoDirectory) {
      this.fail("run the lifecycle script from the same exact checkout it mounts")
    }
    this.validateCheckoutOwnership(canonicalSource)

    const origin = this.readCheckoutOrigin(canonicalSource)
    const allowedOrigins = new Set([
      EXPECTED_ORIGIN_HTTPS,
      EXPECTED_ORIGIN_HTTPS.slice(0, -4),
      "git@github.com:kaspernj/snapreq.git",
      "ssh://git@github.com/kaspernj/snapreq.git"
    ])
    if (!allowedOrigins.has(origin)) this.fail("source origin is not kaspernj/snapreq")
    this.readCheckoutHead(canonicalSource)
    if (!this.fileSystem.existsSync?.(this.composeFile)) this.fail("missing compose.hermes.yml")
  }

  /**
   * Requires Docker Compose v2.
   */
  requireCompose() {
    this.runner.findExecutable("docker", this.environment)
    this.runner.capture("docker", ["compose", "version"])
  }

  /**
   * Builds exact Compose arguments.
   * @param {string[]} arguments_ - Compose command arguments.
   * @returns {string[]} - Docker argument vector.
   */
  composeArguments(arguments_) {
    return [
      "compose",
      "-p",
      this.environment.SNAPREQ_COMPOSE_PROJECT,
      "--file",
      this.composeFile,
      ...arguments_
    ]
  }

  /**
   * Returns the narrowly supplemented Compose environment.
   * @returns {NodeJS.ProcessEnv} - Compose environment.
   */
  composeEnvironment() {
    return {
      ...this.environment,
      COMPOSE_DISABLE_ENV_FILE: "1",
      SNAPREQ_SOURCE_PATH: this.environment.SNAPREQ_SOURCE_PATH,
      SNAPREQ_COMPOSE_PROJECT: this.environment.SNAPREQ_COMPOSE_PROJECT
    }
  }

  /**
   * Captures a Compose query.
   * @param {string[]} arguments_ - Compose command arguments.
   * @returns {string} - Complete stdout.
   */
  composeCapture(arguments_) {
    return this.runner.capture("docker", this.composeArguments(arguments_), {
      env: this.composeEnvironment()
    })
  }

  /**
   * Runs a Compose command with inherited streams.
   * @param {string[]} arguments_ - Compose command arguments.
   * @returns {Promise<void>}
   */
  async composeRun(arguments_) {
    await this.runner.run("docker", this.composeArguments(arguments_), {
      env: this.composeEnvironment()
    })
  }

  /**
   * Resolves exactly one running dev container.
   * @returns {string} - Container ID.
   */
  requireRunningService() {
    const containers = outputLines(this.composeCapture(["ps", "--quiet", "--status", "running", "dev"]))
    if (containers.length === 0) this.fail("Compose dev service is not running")
    if (containers.length !== 1) this.fail("Compose dev service resolved to multiple containers")
    return containers[0]
  }

  /**
   * Computes SHA-256 for a checked-in file.
   * @param {string} filePath - File path.
   * @returns {string} - Hex digest.
   */
  checksum(filePath) {
    return createHash("sha256").update(this.fileSystem.readFileSync(filePath)).digest("hex")
  }

  /**
   * Prints validated outer facts.
   */
  printValidation() {
    const sourcePath = this.environment.SNAPREQ_SOURCE_PATH
    const identity = this.readCheckoutIdentity(sourcePath)
    const stats = this.fileSystem.statSync(sourcePath)
    process.stdout.write([
      `source=${sourcePath}`,
      `project=${this.environment.SNAPREQ_COMPOSE_PROJECT}`,
      `origin=${identity.origin}`,
      `head=${identity.head}`,
      `source-mode-owner=${(stats.mode & 0o777).toString(8)} ${stats.uid}:${stats.gid}`,
      `compose-sha256=${this.checksum(this.composeFile)}`,
      ""
    ].join("\n"))
  }

  /**
   * Runs the in-container proof using this JavaScript entry point.
   * @returns {Promise<void>}
   */
  async runProof() {
    this.requireRunningService()
    const identity = this.readCheckoutIdentity(this.environment.SNAPREQ_SOURCE_PATH)
    await this.composeRun([
      "exec",
      "--no-TTY",
      "--workdir",
      "/workspace",
      "dev",
      "node",
      "scripts/hermes-compose.js",
      "_container-proof",
      identity.head,
      identity.origin,
      this.checksum(this.composeFile)
    ])
  }

  /**
   * Performs proof checks inside the dev service.
   * @param {string[]} arguments_ - Expected head, origin, and checksum.
   */
  containerProof(arguments_) {
    if (arguments_.length !== 3) this.fail("_container-proof requires HEAD ORIGIN CHECKSUM")
    const [expectedHead, expectedOrigin, expectedChecksum] = arguments_
    const root = this.runner.capture("git", ["rev-parse", "--show-toplevel"]).trim()
    const head = this.runner.capture("git", ["rev-parse", "HEAD"]).trim()
    const origin = this.runner.capture("git", ["remote", "get-url", "origin"]).trim()
    const workspace = realpathSync(process.cwd())
    const stats = statSync("/workspace")
    if (workspace !== "/workspace" || root !== "/workspace") this.fail("in-container Git root mismatch")
    if (head !== expectedHead || origin !== expectedOrigin) this.fail("in-container Git identity mismatch")
    const checksum = this.checksum(join(process.cwd(), "compose.hermes.yml"))
    if (checksum !== expectedChecksum) this.fail("in-container Compose checksum mismatch")
    if (stats.uid !== EXPECTED_UID || stats.gid !== EXPECTED_GID || (stats.mode & 0o002) !== 0) {
      this.fail("in-container workspace ownership mismatch")
    }
    const nodeVersion = this.runner.capture("node", ["--version"]).trim()
    const codexVersion = this.runner.capture("codex", ["--version"]).trim()
    process.stdout.write([
      `pwd=${workspace}`,
      `root=${root}`,
      `origin=${origin}`,
      `head=${head}`,
      `compose-sha256=${checksum}`,
      `workspace-mode-owner=${(stats.mode & 0o777).toString(8)} ${stats.uid}:${stats.gid}`,
      `node=${nodeVersion}`,
      `codex=${codexVersion}`,
      ""
    ].join("\n"))
  }

  /**
   * Copies the mounted auth file into the task Codex home.
   */
  containerInitializeCodex() {
    const source = "/source/auth.json"
    const destination = "/home/node/.codex/auth.json"
    const sourceStats = lstatSync(source)
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.size === 0) {
      this.fail("Codex auth source must be a nonempty regular file")
    }
    process.umask(0o077)
    copyFileSync(source, destination)
    chmodSync(destination, 0o600)
    const destinationStats = statSync(destination)
    if (
      destinationStats.uid !== EXPECTED_UID ||
      destinationStats.gid !== EXPECTED_GID ||
      (destinationStats.mode & 0o777) !== 0o600
    ) {
      this.fail("initialized Codex auth ownership or mode mismatch")
    }
  }

  /**
   * Initializes the task-owned Codex auth volume.
   * @returns {Promise<void>}
   */
  async initializeCodex() {
    const authVolume = this.environment.SNAPREQ_CODEX_AUTH_VOLUME || ""
    if (!authVolume) this.fail("SNAPREQ_CODEX_AUTH_VOLUME is required")
    this.validateAuthVolumeName(authVolume)
    const project = this.environment.SNAPREQ_COMPOSE_PROJECT
    if ([
      `${project}_node_modules`,
      `${project}_npm_cache`,
      `${project}_codex_home`
    ].includes(authVolume)) {
      this.fail("Codex auth source must be separate from task-owned mutable volumes")
    }
    const inspected = this.runner.capture(
      "docker",
      ["volume", "inspect", "--format", "{{.Name}}", authVolume],
      {quiet: true}
    ).trim()
    if (inspected !== authVolume) this.fail("Docker resolved an unexpected Codex auth volume")

    await this.composeRun([
      "run",
      "--rm",
      "--no-deps",
      "--no-TTY",
      "--user",
      "1000:1000",
      "--volume",
      `${authVolume}:/source:ro`,
      "--entrypoint",
      "node",
      "dev",
      "/workspace/scripts/hermes-compose.js",
      "_initialize-codex-auth"
    ])
    process.stdout.write(
      `Initialized Codex authentication in project ${project} without exposing its contents.\n`
    )
  }

  /**
   * Rejects Threadwire arguments that would replace managed boundaries.
   * @param {string[]} arguments_ - Threadwire arguments.
   */
  validateThreadwireArguments(arguments_) {
    for (const argument of arguments_) {
      if (/^--(?:provider|target|cwd|workspace-profile)(?:=|$)/.test(argument)) {
        this.fail("Threadwire provider, target, cwd, and workspace profile are managed by hermes-compose")
      }
    }
  }

  /**
   * Rejects build inputs outside the checked-in Compose file.
   * @param {string[]} arguments_ - Build arguments.
   */
  validateBuildArguments(arguments_) {
    for (const argument of arguments_) {
      if (/^--(?:build-arg|build-context|secret|ssh)(?:=|$)/.test(argument)) {
        this.fail("Dockerfile inputs and build credentials are fixed by compose.hermes.yml")
      }
    }
  }

  /**
   * Launches Threadwire through the checked-in provider.
   * @param {string[]} arguments_ - Threadwire run arguments.
   * @returns {Promise<void>}
   */
  async launchThreadwire(arguments_) {
    const target = this.environment.THREADWIRE_TARGET || ""
    if (!/^telegram:-?[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(target)) {
      this.fail("THREADWIRE_TARGET must be telegram:<nonzero-chat-id>[:<positive-thread-id>]")
    }
    this.validateThreadwireArguments(arguments_)
    this.requireRunningService()
    const executable = this.runner.findExecutable(this.environment.THREADWIRE_BIN || "threadwire")
    const adapter = join(this.repoDirectory, "scripts", "threadwire-compose-provider.js")
    try {
      accessExecutable(adapter)
    } catch {
      this.fail("Threadwire Compose provider adapter is not executable")
    }
    await this.runner.run(executable, [
      "run",
      "--provider",
      "codex",
      "--target",
      target,
      "--cwd",
      this.environment.SNAPREQ_SOURCE_PATH,
      ...arguments_
    ], {
      env: {
        ...this.environment,
        THREADWIRE_CODEX_BIN: adapter,
        SNAPREQ_SOURCE_PATH: this.environment.SNAPREQ_SOURCE_PATH,
        SNAPREQ_COMPOSE_PROJECT: this.environment.SNAPREQ_COMPOSE_PROJECT
      }
    })
  }

  /**
   * Purges only confirmed, unreferenced task resources.
   * @returns {Promise<void>}
   */
  async purgeProjectResources() {
    const project = this.environment.SNAPREQ_COMPOSE_PROJECT
    if (this.environment.SNAPREQ_PURGE_PROJECT !== project) {
      this.fail(`set SNAPREQ_PURGE_PROJECT exactly to ${project} to purge`)
    }
    await this.composeRun(["down", "--remove-orphans"])
    if (outputLines(this.composeCapture(["ps", "--all", "--quiet"])).length !== 0) {
      this.fail("project still has containers after down")
    }

    const volumeNames = new Set(outputLines(this.runner.capture("docker", ["volume", "ls", "--format", "{{.Name}}"])))
    for (const purpose of ["node_modules", "npm_cache", "codex_home"]) {
      const volumeName = `${project}_${purpose}`
      if (!volumeNames.has(volumeName)) continue
      const volumeProject = this.runner.capture(
        "docker",
        ["volume", "inspect", "--format", "{{index .Labels \"com.docker.compose.project\"}}", volumeName]
      ).trim()
      const hermesProject = this.runner.capture(
        "docker",
        ["volume", "inspect", "--format", "{{index .Labels \"io.snapreq.hermes.project\"}}", volumeName]
      ).trim()
      const volumePurpose = this.runner.capture(
        "docker",
        ["volume", "inspect", "--format", "{{index .Labels \"io.snapreq.hermes.purpose\"}}", volumeName]
      ).trim()
      if (volumeProject !== project || hermesProject !== project || volumePurpose !== purpose) {
        this.fail(`refusing to remove ambiguously labeled volume ${volumeName}`)
      }
      const references = outputLines(this.runner.capture(
        "docker",
        ["container", "ls", "--all", "--quiet", "--filter", `volume=${volumeName}`]
      ))
      if (references.length !== 0) this.fail(`container still references ${volumeName}`)
      await this.runner.run("docker", ["volume", "rm", volumeName])
    }

    const networkName = `${project}_default`
    const networkNames = new Set(outputLines(this.runner.capture("docker", ["network", "ls", "--format", "{{.Name}}"])))
    if (networkNames.has(networkName)) {
      const networkProject = this.runner.capture(
        "docker",
        ["network", "inspect", "--format", "{{index .Labels \"com.docker.compose.project\"}}", networkName]
      ).trim()
      const hermesProject = this.runner.capture(
        "docker",
        ["network", "inspect", "--format", "{{index .Labels \"io.snapreq.hermes.project\"}}", networkName]
      ).trim()
      const references = this.runner.capture(
        "docker",
        ["network", "inspect", "--format", "{{len .Containers}}", networkName]
      ).trim()
      if (networkProject !== project || hermesProject !== project) {
        this.fail(`refusing to remove ambiguously labeled network ${networkName}`)
      }
      if (references !== "0") this.fail(`network ${networkName} still has live references`)
      await this.runner.run("docker", ["network", "rm", networkName])
    }

    const imageName = `${project}-dev`
    const imageNames = new Set(outputLines(this.runner.capture("docker", ["image", "ls", "--format", "{{.Repository}}"])))
    if (imageNames.has(imageName)) {
      const imageType = this.runner.capture(
        "docker",
        ["image", "inspect", "--format", "{{index .Config.Labels \"io.snapreq.hermes.image\"}}", imageName]
      ).trim()
      const imageProject = this.runner.capture(
        "docker",
        ["image", "inspect", "--format", "{{index .Config.Labels \"io.snapreq.hermes.project\"}}", imageName]
      ).trim()
      if (imageType !== "dev" || imageProject !== project) {
        this.fail(`refusing to remove ambiguously labeled image ${imageName}`)
      }
      const references = outputLines(this.runner.capture(
        "docker",
        ["container", "ls", "--all", "--quiet", "--filter", `ancestor=${imageName}`]
      ))
      if (references.length !== 0) this.fail(`container still references image ${imageName}`)
      await this.runner.run("docker", ["image", "rm", imageName])
    }
  }

  /**
   * Verifies one smoke stack from inside its dev container.
   * @param {string[]} arguments_ - Project, head, marker checksum.
   */
  containerAssertSmokeStack(arguments_) {
    if (arguments_.length !== 3) this.fail("_assert-smoke-stack requires PROJECT HEAD MARKER_CHECKSUM")
    const [project, expectedHead, expectedMarkerChecksum] = arguments_
    const root = this.runner.capture("git", ["rev-parse", "--show-toplevel"]).trim()
    const head = this.runner.capture("git", ["rev-parse", "HEAD"]).trim()
    const status = this.runner.capture("git", ["status", "--porcelain"])
    const markerChecksum = this.checksum(join(process.cwd(), ".hermes-smoke-marker"))
    if (
      realpathSync(process.cwd()) !== "/workspace" ||
      root !== "/workspace" ||
      head !== expectedHead ||
      this.environment.HERMES_COMPOSE_PROJECT !== project ||
      markerChecksum !== expectedMarkerChecksum ||
      !existsSync("/workspace/node_modules") ||
      status !== ""
    ) {
      this.fail("smoke stack identity mismatch")
    }
  }

  /**
   * Prints usage.
   * @returns {string} - Usage text.
   */
  usage() {
    return `Usage: scripts/hermes-compose.js COMMAND [ARGS]

Commands:
  validate                 Validate and print source/project/Git/checksum facts
  config                   Render the checked-in Compose configuration
  build [BUILD_ARGS]       Build the task-owned development image
  up                       Start the long-running dev service
  status                   Show this project's Compose status
  exec [--no-tty] [CMD...] Execute a command in /workspace (default: node)
  proof                    Verify and print in-container source/toolchain facts
  init-codex               Seed task Codex state from SNAPREQ_CODEX_AUTH_VOLUME
  threadwire [RUN_ARGS]    Launch host Threadwire through the Compose provider
  down                     Stop only this project; preserve mutable volumes
  purge                    Remove confirmed, unreferenced task volumes/network/image
`
  }

  /**
   * Runs one lifecycle command.
   * @param {string[]} arguments_ - CLI arguments without node/script.
   * @returns {Promise<void>}
   */
  async main(arguments_) {
    const [commandName = "", ...commandArguments] = arguments_
    if (commandName === "_validate-project-pair") {
      if (commandArguments.length !== 2) this.fail("_validate-project-pair requires TASK PROJECT")
      this.validateProjectPair(commandArguments[0], commandArguments[1])
      return
    }
    if (commandName === "_validate-checkout-ownership") {
      if (commandArguments.length !== 1) this.fail("_validate-checkout-ownership requires CHECKOUT")
      this.validateCheckoutOwnership(commandArguments[0])
      return
    }
    if (commandName === "_validate-auth-volume-name") {
      if (commandArguments.length !== 1) this.fail("_validate-auth-volume-name requires VOLUME")
      this.validateAuthVolumeName(commandArguments[0])
      return
    }
    if (commandName === "_read-checkout-identity") {
      if (commandArguments.length !== 1) this.fail("_read-checkout-identity requires CHECKOUT")
      this.validateCheckoutOwnership(commandArguments[0])
      const identity = this.readCheckoutIdentity(commandArguments[0])
      process.stdout.write(`head=${identity.head}\norigin=${identity.origin}\n`)
      return
    }
    if (commandName === "_container-proof") {
      this.containerProof(commandArguments)
      return
    }
    if (commandName === "_initialize-codex-auth") {
      if (commandArguments.length !== 0) this.fail("_initialize-codex-auth takes no arguments")
      this.containerInitializeCodex()
      return
    }
    if (commandName === "_assert-smoke-stack") {
      this.containerAssertSmokeStack(commandArguments)
      return
    }
    if (["help", "-h", "--help"].includes(commandName)) {
      process.stdout.write(this.usage())
      return
    }
    if (!commandName) {
      process.stderr.write(this.usage())
      this.fail("command is required")
    }

    this.validateSourceAndProject()
    switch (commandName) {
      case "validate":
        if (commandArguments.length !== 0) this.fail("validate takes no arguments")
        this.printValidation()
        break
      case "config":
        if (commandArguments.length !== 0) this.fail("config takes no arguments")
        this.requireCompose()
        await this.composeRun(["config"])
        break
      case "build":
        this.requireCompose()
        this.validateBuildArguments(commandArguments)
        await this.composeRun(["build", ...commandArguments, "dev"])
        break
      case "up":
        if (commandArguments.length !== 0) this.fail("up takes no arguments")
        this.requireCompose()
        await this.composeRun(["up", "--detach", "--wait", "dev"])
        break
      case "status":
        if (commandArguments.length !== 0) this.fail("status takes no arguments")
        this.requireCompose()
        await this.composeRun(["ps"])
        break
      case "exec": {
        this.requireCompose()
        this.requireRunningService()
        const command = [...commandArguments]
        const ttyArguments = command[0] === "--no-tty" ? ["--no-TTY"] : []
        if (ttyArguments.length) command.shift()
        if (command.length === 0) command.push("node")
        await this.composeRun([
          "exec",
          ...ttyArguments,
          "--workdir",
          "/workspace",
          "dev",
          ...command
        ])
        break
      }
      case "provider-exec":
        if (this.environment.THREADWIRE_ACTIVE !== "1") {
          this.fail("provider-exec is reserved for an active Threadwire child")
        }
        if (commandArguments.length === 0) this.fail("provider-exec requires a provider command")
        this.requireCompose()
        this.requireRunningService()
        await this.composeRun([
          "exec",
          "--no-TTY",
          "--workdir",
          "/workspace",
          "dev",
          ...commandArguments
        ])
        break
      case "proof":
        if (commandArguments.length !== 0) this.fail("proof takes no arguments")
        this.requireCompose()
        await this.runProof()
        break
      case "container-id":
        if (commandArguments.length !== 0) this.fail("container-id takes no arguments")
        this.requireCompose()
        process.stdout.write(`${this.requireRunningService()}\n`)
        break
      case "init-codex":
        if (commandArguments.length !== 0) this.fail("init-codex takes no arguments")
        this.requireCompose()
        await this.initializeCodex()
        break
      case "threadwire":
        this.requireCompose()
        await this.launchThreadwire(commandArguments)
        break
      case "down":
        if (commandArguments.length !== 0) this.fail("down takes no arguments")
        this.requireCompose()
        await this.composeRun(["down", "--remove-orphans"])
        break
      case "purge":
        if (commandArguments.length !== 0) this.fail("purge takes no arguments")
        this.requireCompose()
        await this.purgeProjectResources()
        break
      default:
        process.stderr.write(this.usage())
        this.fail(`unknown command: ${commandName}`)
    }
  }
}

/**
 * Requires an executable path.
 * @param {string} filePath - Exact executable path.
 */
function accessExecutable(filePath) {
  const stats = statSync(filePath)
  if (!stats.isFile() || (stats.mode & 0o111) === 0) throw new Error("not executable")
}

if (isMain(import.meta.url)) {
  const cli = new HermesComposeCli()
  await runMain(() => cli.main(process.argv.slice(2)), "hermes-compose")
}
