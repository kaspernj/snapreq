#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs"
import {createHash} from "node:crypto"
import {
  CommandFailure,
  CommandRunner,
  isMain,
  runMain
} from "./hermes-command.js"

const ALLOWED_ORIGINS = new Set([
  "https://github.com/kaspernj/snapreq.git",
  "https://github.com/kaspernj/snapreq",
  "git@github.com:kaspernj/snapreq.git",
  "ssh://git@github.com/kaspernj/snapreq.git"
])

/**
 * Owns checkout creation inside the narrowly mounted bootstrap container.
 */
export class SmokeBootstrap {
  /**
   * @param {{environment?: NodeJS.ProcessEnv, runner?: CommandRunner}} [options] - Runtime boundaries.
   */
  constructor(options = {}) {
    this.environment = options.environment || process.env
    this.runner = options.runner || new CommandRunner({environment: this.environment})
  }

  /**
   * Rejects an unsafe bootstrap state.
   * @param {string} message - Safe error message.
   * @returns {never}
   */
  fail(message) {
    throw new CommandFailure(message, {status: 2})
  }

  /**
   * Requires a non-symlink directory with uid/gid 1000 and no world write bit.
   * @param {string} directory - Exact mounted directory.
   * @param {string} label - Human-readable boundary.
   */
  validateDirectory(directory, label) {
    const linkStats = lstatSync(directory)
    const stats = statSync(directory)
    if (!linkStats.isDirectory() || linkStats.isSymbolicLink()) this.fail(`${label} mount is invalid`)
    if (stats.uid !== 1000 || stats.gid !== 1000) this.fail(`${label} ownership mismatch`)
    if ((stats.mode & 0o002) !== 0) this.fail(`${label} is world-writable`)
  }

  /**
   * Runs the container-only clone/branch/marker/commit flow.
   * @param {string[]} arguments_ - Smoke branch and project.
   * @returns {Promise<void>}
   */
  async main(arguments_) {
    if (this.environment.HERMES_SMOKE_BOOTSTRAP !== "1") {
      this.fail("container bootstrap marker is required")
    }
    if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
      this.fail("bootstrap must run as uid/gid 1000:1000")
    }
    if (arguments_.length !== 2) this.fail("expected BRANCH PROJECT")
    const [branchName, projectName] = arguments_
    if (!branchName.startsWith("hermes-smoke/")) this.fail("invalid smoke branch")
    const taskName = branchName.slice("hermes-smoke/".length)
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(taskName)) this.fail("invalid smoke task")
    if (branchName !== `hermes-smoke/${taskName}`) this.fail("invalid smoke branch")
    if (projectName !== `snapreq-${taskName}`) this.fail("smoke project and branch do not match")

    this.validateDirectory("/source", "source root")
    this.validateDirectory("/source/.git", "source .git")
    this.validateDirectory("/destination", "destination")
    if (readdirSync("/destination").length !== 0) this.fail("destination is not empty")
    if (realpathSync("/source") !== "/source") this.fail("source path is not canonical")
    if (realpathSync("/destination") !== "/destination") this.fail("destination path is not canonical")

    const sourceRoot = this.runner.capture("git", ["-C", "/source", "rev-parse", "--show-toplevel"]).trim()
    const sourceStatus = this.runner.capture("git", ["-C", "/source", "status", "--porcelain"])
    if (sourceRoot !== "/source") this.fail("source Git root mismatch")
    if (sourceStatus !== "") this.fail("source must be clean so the smoke clones contain the implementation")
    const sourceOrigin = this.runner.capture("git", ["-C", "/source", "remote", "get-url", "origin"]).trim()
    if (!ALLOWED_ORIGINS.has(sourceOrigin)) this.fail("source origin is not kaspernj/snapreq")
    const baseHead = this.runner.capture("git", ["-C", "/source", "rev-parse", "HEAD"]).trim()
    if (!/^[0-9a-f]{40}$/.test(baseHead)) this.fail("source HEAD is not a full SHA-1")

    await this.runner.run("git", ["clone", "--no-local", "--no-checkout", "/source", "/destination"])
    await this.runner.run("git", ["-C", "/destination", "remote", "set-url", "origin", sourceOrigin])
    await this.runner.run("git", [
      "-C",
      "/destination",
      "checkout",
      "--quiet",
      "-b",
      branchName,
      baseHead
    ])
    const markerPath = "/destination/.hermes-smoke-marker"
    writeFileSync(markerPath, `stack=${projectName}\n`, {mode: 0o644})
    await this.runner.run("git", ["-C", "/destination", "add", ".hermes-smoke-marker"])
    await this.runner.run("git", [
      "-C",
      "/destination",
      "-c",
      "user.name=SnapReq Hermes Smoke",
      "-c",
      "user.email=hermes-smoke@invalid.example",
      "commit",
      "--quiet",
      "-m",
      `test: distinguish ${projectName}`
    ])

    const head = this.runner.capture("git", ["-C", "/destination", "rev-parse", "HEAD"]).trim()
    const markerChecksum = createHash("sha256").update(readFileSync(markerPath)).digest("hex")
    const destinationStatus = this.runner.capture("git", ["-C", "/destination", "status", "--porcelain"])
    if (destinationStatus !== "") this.fail("bootstrapped checkout is dirty")
    process.stdout.write(
      `head=${head} marker_sha256=${markerChecksum} base_head=${baseHead} origin=${sourceOrigin}\n`
    )
  }
}

if (isMain(import.meta.url)) {
  const bootstrap = new SmokeBootstrap()
  await runMain(() => bootstrap.main(process.argv.slice(2)), "hermes-smoke-bootstrap")
}
