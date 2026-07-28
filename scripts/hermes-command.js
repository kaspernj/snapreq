#!/usr/bin/env node

import {accessSync, constants as fileConstants} from "node:fs"
import {spawn, spawnSync} from "node:child_process"
import {delimiter, isAbsolute, resolve} from "node:path"
import {pathToFileURL} from "node:url"

/**
 * A subprocess failure with its exact process outcome.
 */
export class CommandFailure extends Error {
  /**
   * @param {string} message - Safe failure summary.
   * @param {{status?: number | null, signal?: NodeJS.Signals | null, stderr?: string}} [details] - Process outcome.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = "CommandFailure"
    this.status = details.status ?? null
    this.signal = details.signal ?? null
    this.stderr = details.stderr || ""
  }
}

/**
 * Runs external commands with exact argument arrays and no shell.
 */
export class CommandRunner {
  /**
   * @param {{cwd?: string, environment?: NodeJS.ProcessEnv}} [options] - Runner defaults.
   */
  constructor(options = {}) {
    this.cwd = options.cwd
    this.environment = options.environment || process.env
  }

  /**
   * Returns a complete captured process result without interpreting its status.
   * @param {string} command - Executable name or path.
   * @param {string[]} arguments_ - Exact argument vector.
   * @param {{cwd?: string, env?: NodeJS.ProcessEnv, input?: string | Buffer}} [options] - Process options.
   * @returns {{stdout: string, stderr: string, status: number | null, signal: NodeJS.Signals | null, error?: Error}} - Result.
   */
  captureResult(command, arguments_, options = {}) {
    const result = spawnSync(command, arguments_, {
      cwd: options.cwd || this.cwd,
      encoding: "utf8",
      env: options.env || this.environment,
      input: options.input,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    })

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      status: result.status,
      signal: result.signal,
      error: result.error
    }
  }

  /**
   * Captures stdout and rejects every spawn, signal, or nonzero-status failure.
   * @param {string} command - Executable name or path.
   * @param {string[]} arguments_ - Exact argument vector.
   * @param {{cwd?: string, env?: NodeJS.ProcessEnv, input?: string | Buffer, quiet?: boolean, forwardStderr?: boolean}} [options] - Process options.
   * @returns {string} - Complete stdout.
   */
  capture(command, arguments_, options = {}) {
    const result = this.captureResult(command, arguments_, options)
    if (result.stderr && (options.forwardStderr || !options.quiet)) process.stderr.write(result.stderr)
    if (result.error || result.signal || result.status !== 0) {
      throw new CommandFailure(`${command} failed`, {
        status: result.status,
        signal: result.signal,
        stderr: result.stderr
      })
    }
    return result.stdout
  }

  /**
   * Runs an interactive command with inherited streams and forwarded signals.
   * @param {string} command - Executable name or path.
   * @param {string[]} arguments_ - Exact argument vector.
   * @param {{cwd?: string, env?: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions}} [options] - Process options.
   * @returns {Promise<void>} - Resolves on exit zero.
   */
  async run(command, arguments_, options = {}) {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, arguments_, {
        cwd: options.cwd || this.cwd,
        env: options.env || this.environment,
        shell: false,
        stdio: options.stdio || "inherit"
      })
      /** @type {NodeJS.Signals | null} */
      let forwardedSignal = null
      /** @type {Map<NodeJS.Signals, () => void>} */
      const signalHandlers = new Map()

      const cleanup = () => {
        for (const [signal, handler] of signalHandlers) process.off(signal, handler)
      }
      for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
        const handler = () => {
          forwardedSignal = signal
          child.kill(signal)
        }
        signalHandlers.set(signal, handler)
        process.on(signal, handler)
      }

      child.once("error", (error) => {
        cleanup()
        rejectPromise(new CommandFailure(`${command} failed to start`, {stderr: error.message}))
      })
      child.once("close", (status, signal) => {
        cleanup()
        if (forwardedSignal || signal || status !== 0) {
          rejectPromise(new CommandFailure(`${command} failed`, {
            status,
            signal: forwardedSignal || signal
          }))
          return
        }
        resolvePromise(undefined)
      })
    })
  }

  /**
   * Resolves an executable through PATH without invoking a shell.
   * @param {string} command - Executable name or path.
   * @param {NodeJS.ProcessEnv} [environment] - Environment containing PATH.
   * @returns {string} - Executable path.
   */
  findExecutable(command, environment = this.environment) {
    const candidates = command.includes("/") || isAbsolute(command)
      ? [resolve(command)]
      : (environment.PATH || "").split(delimiter).filter(Boolean).map((entry) => resolve(entry, command))

    for (const candidate of candidates) {
      try {
        accessSync(candidate, fileConstants.X_OK)
        return candidate
      } catch {
        // Continue through the exact PATH candidates.
      }
    }
    throw new CommandFailure(`${command} is not installed or executable`, {status: 2})
  }
}

/**
 * Splits captured line output while treating empty output as no records.
 * @param {string} output - Captured stdout.
 * @returns {string[]} - Nonempty output lines with CR removed.
 */
export function outputLines(output) {
  if (!output) return []
  return output.replace(/\r/g, "").split("\n").filter((line) => line.length > 0)
}

/**
 * Reports whether a module is the directly executed entry point.
 * @param {string} moduleUrl - Module import URL.
 * @returns {boolean} - True for direct execution.
 */
export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(resolve(process.argv[1])).href
}

/**
 * Runs a CLI main function with consistent safe failure reporting.
 * @param {() => Promise<void> | void} main - CLI entry point.
 * @param {string} prefix - Error prefix.
 * @returns {Promise<void>}
 */
export async function runMain(main, prefix) {
  try {
    await main()
  } catch (error) {
    if (error instanceof CommandFailure) {
      if (error.signal) {
        process.kill(process.pid, error.signal)
        return
      }
      if (error.stderr && !error.message.endsWith("failed")) process.stderr.write(error.stderr)
      process.stderr.write(`${prefix}: ${error.message}\n`)
      process.exitCode = error.status && error.status > 0 ? error.status : 2
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${prefix}: ${message}\n`)
    process.exitCode = 2
  }
}
