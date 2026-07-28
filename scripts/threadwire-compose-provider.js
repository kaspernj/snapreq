#!/usr/bin/env node

import {statSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"
import {
  CommandFailure,
  CommandRunner,
  isMain,
  runMain
} from "./hermes-command.js"

/**
 * Owns the Threadwire-to-Compose provider boundary.
 */
export class ThreadwireComposeProvider {
  /**
   * @param {{environment?: NodeJS.ProcessEnv, runner?: CommandRunner, scriptPath?: string}} [options] - Runtime boundaries.
   */
  constructor(options = {}) {
    this.environment = options.environment || process.env
    this.runner = options.runner || new CommandRunner({environment: this.environment})
    this.scriptPath = options.scriptPath || fileURLToPath(import.meta.url)
  }

  /**
   * Rejects an invalid provider invocation.
   * @param {string} message - Safe error message.
   * @returns {never}
   */
  fail(message) {
    throw new CommandFailure(message, {status: 2})
  }

  /**
   * Validates Threadwire-generated Codex arguments.
   * @param {string[]} arguments_ - Codex arguments.
   */
  validateArguments(arguments_) {
    if (this.environment.THREADWIRE_ACTIVE !== "1") {
      this.fail("this adapter may only be invoked as a Threadwire provider child")
    }
    if (arguments_.length === 0) this.fail("missing Codex arguments")
    if (!["exec", "resume"].includes(arguments_[0])) {
      this.fail("Threadwire Codex mode must begin with exec or resume")
    }

    for (const argument of arguments_) {
      if (
        /^(?:-C(?:$|.)|--cd(?:=|$)|--add-dir(?:=|$)|-s(?:$|.)|--sandbox(?:=|$)|-a(?:$|.)|--ask-for-approval(?:=|$)|-c(?:$|.)|--config(?:=|$)|--dangerously-|--remote(?:=|$)|--remote-auth-token-env(?:=|$))/.test(argument)
      ) {
        this.fail("Threadwire supplied a Codex argument that can change the container boundary")
      }
    }
  }

  /**
   * Runs Codex only through the lifecycle helper in the dev service.
   * @param {string[]} arguments_ - Threadwire-generated Codex arguments.
   * @returns {Promise<void>}
   */
  async main(arguments_) {
    this.validateArguments(arguments_)
    const helper = join(dirname(this.scriptPath), "hermes-compose.js")
    let helperStats
    try {
      helperStats = statSync(helper)
    } catch {
      this.fail("missing executable Hermes Compose lifecycle helper")
    }
    if (!helperStats.isFile() || (helperStats.mode & 0o111) === 0) {
      this.fail("missing executable Hermes Compose lifecycle helper")
    }

    await this.runner.run(helper, [
      "provider-exec",
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      "/workspace",
      ...arguments_
    ], {
      env: this.environment
    })
  }
}

if (isMain(import.meta.url)) {
  const provider = new ThreadwireComposeProvider()
  await runMain(() => provider.main(process.argv.slice(2)), "threadwire-compose-provider")
}
