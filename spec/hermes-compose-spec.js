// @ts-check

import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import {spawn, spawnSync} from "node:child_process"
import {fileURLToPath, pathToFileURL} from "node:url"
import path from "node:path"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const scriptsDirectory = path.join(repoRoot, "scripts")
const commandModule = path.join(scriptsDirectory, "hermes-command.js")
const lifecycle = path.join(scriptsDirectory, "hermes-compose.js")
const provider = path.join(scriptsDirectory, "threadwire-compose-provider.js")
const smoke = path.join(scriptsDirectory, "hermes-smoke.js")
const smokeBootstrap = path.join(scriptsDirectory, "hermes-smoke-bootstrap.js")
const scripts = [lifecycle, provider, smoke, smokeBootstrap]
const removedScripts = [
  path.join(scriptsDirectory, "hermes-compose"),
  path.join(scriptsDirectory, "threadwire-compose-provider"),
  path.join(scriptsDirectory, "hermes-smoke"),
  path.join(scriptsDirectory, "hermes-smoke-bootstrap")
]
let temporaryRoot

/**
 * Runs a command without inheriting credential-bearing environment variables.
 * @param {string} command - Executable path.
 * @param {string[]} arguments_ - Argument vector.
 * @param {Record<string, string>} [extraEnvironment] - Explicit safe environment additions.
 * @param {{input?: string}} [options] - Optional process input.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} - Completed child result.
 */
function run(command, arguments_, extraEnvironment = {}, options = {}) {
  return spawnSync(command, arguments_, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...extraEnvironment
    },
    input: options.input
  })
}

/**
 * Imports a script without running its CLI.
 * @param {string} script - Absolute module path.
 * @returns {Promise<Record<string, unknown>>} - Imported module namespace.
 */
async function importScript(script) {
  return import(`${pathToFileURL(script).href}?test=${Math.random()}`)
}

before(() => {
  const taskTemp = path.join(repoRoot, "tmp")
  mkdirSync(taskTemp, {recursive: true})
  temporaryRoot = mkdtempSync(path.join(taskTemp, "hermes-compose-spec-"))
})

after(() => {
  if (temporaryRoot) rmSync(temporaryRoot, {recursive: true, force: true})
})

describe("Hermes JavaScript entry points", () => {
  it("uses executable importable Node ESM scripts and removes the Bash entry points", async () => {
    for (const removedScript of removedScripts) {
      assert.equal(existsSync(removedScript), false, `${path.basename(removedScript)} must be renamed`)
    }

    for (const script of [commandModule, ...scripts]) {
      assert.ok(existsSync(script), `missing ${path.basename(script)}`)
      assert.ok(statSync(script).mode & 0o100, `${path.basename(script)} must be executable`)
      assert.match(readFileSync(script, "utf8"), /^#!\/usr\/bin\/env node\n/)
      assert.equal(run(process.execPath, ["--check", script]).status, 0)
      await importScript(script)
    }
  })

  it("contains no shell execution shortcuts or old script references", () => {
    const reviewedFiles = [
      ...scripts,
      commandModule,
      path.join(repoRoot, "AGENTS.md"),
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "changelog.d/20260728105114-hermes-compose.md")
    ]

    for (const reviewedFile of reviewedFiles) {
      const source = readFileSync(reviewedFile, "utf8")
      assert.doesNotMatch(
        source,
        /#!\/usr\/bin\/env bash|shell:\s*true|\/bin\/(?:ba)?sh|\b(?:bash|sh)\s+-c|--input-type=module|--eval/
      )
      assert.doesNotMatch(
        source,
        /scripts\/(?:hermes-compose|hermes-smoke-bootstrap|hermes-smoke|threadwire-compose-provider)(?![A-Za-z0-9_.-])/
      )
    }

    const lifecycleSource = readFileSync(lifecycle, "utf8")
    assert.doesNotMatch(lifecycleSource, /default: bash|command\.push\("bash"\)/)
    assert.match(lifecycleSource, /default: node|command\.push\("node"\)/)
  })

  it("accepts only matching normalized project/task pairs through the CLI", () => {
    const valid = run(lifecycle, ["_validate-project-pair", "10575-a", "snapreq-10575-a"])
    assert.equal(valid.status, 0, valid.stderr)

    for (const [task, project] of [
      ["10575-a", "snapreq-10575-b"],
      ["../10575", "snapreq-../10575"],
      ["UPPER", "snapreq-UPPER"],
      ["trailing-", "snapreq-trailing-"],
      ["10575", "other-10575"]
    ]) {
      const invalid = run(lifecycle, ["_validate-project-pair", task, project])
      assert.equal(invalid.status, 2, `${task}/${project} unexpectedly passed`)
    }
  })

  it("fails closed when a source is outside the exact Hermes worktree root", () => {
    const invalidSource = run(lifecycle, ["validate"], {
      SNAPREQ_COMPOSE_PROJECT: "snapreq-workspace",
      SNAPREQ_SOURCE_PATH: repoRoot.replace(/\/$/, "")
    })

    assert.equal(invalidSource.status, 2)
    assert.match(invalidSource.stderr, /exact task checkout/)
  })
})

describe("Threadwire Compose provider", () => {
  /**
   * Installs the provider beside a capture-only JavaScript lifecycle stand-in.
   * @param {boolean} [waitForSignal] - Whether the helper waits for a forwarded signal.
   * @returns {{adapter: string, capture: string, ready: string, signal: string}} - Fixture paths.
   */
  function providerFixture(waitForSignal = false) {
    const fixture = path.join(temporaryRoot, `provider-${Math.random().toString(16).slice(2)}`)
    const fixtureScripts = path.join(fixture, "scripts")
    const adapter = path.join(fixtureScripts, "threadwire-compose-provider.js")
    const helper = path.join(fixtureScripts, "hermes-compose.js")
    const shared = path.join(fixtureScripts, "hermes-command.js")
    const capture = path.join(fixture, "capture.json")
    const ready = path.join(fixture, "ready")
    const signal = path.join(fixture, "signal")

    mkdirSync(fixtureScripts, {recursive: true})
    copyFileSync(provider, adapter)
    copyFileSync(commandModule, shared)
    writeFileSync(helper, [
      "#!/usr/bin/env node",
      "",
      "import {readFileSync, writeFileSync} from \"node:fs\"",
      "",
      "const input = readFileSync(0, \"utf8\")",
      "writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({arguments: process.argv.slice(2), input}))",
      waitForSignal
        ? "writeFileSync(process.env.READY_FILE, \"ready\\n\")"
        : "process.exit(0)",
      ...(waitForSignal
        ? [
            "process.on(\"SIGTERM\", () => {",
            "  writeFileSync(process.env.SIGNAL_FILE, \"SIGTERM\\n\")",
            "  process.exit(143)",
            "})",
            "setInterval(() => {}, 1000)"
          ]
        : []),
      ""
    ].join("\n"), {mode: 0o755})
    chmodSync(adapter, 0o755)
    chmodSync(shared, 0o755)

    return {adapter, capture, ready, signal}
  }

  it("injects the boundary arguments and forwards stdin", () => {
    const {adapter, capture} = providerFixture()
    const result = run(adapter, ["exec", "--json", "-"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    }, {input: "provider-input\n"})

    assert.equal(result.status, 0, result.stderr)
    const captured = JSON.parse(readFileSync(capture, "utf8"))
    assert.deepEqual(captured.arguments, [
      "provider-exec",
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      "/workspace",
      "exec",
      "--json",
      "-"
    ])
    assert.equal(captured.input, "provider-input\n")
  })

  it("supports resume ordering and rejects boundary-changing calls", () => {
    const {adapter, capture} = providerFixture()
    const resume = run(adapter, ["resume", "session-id"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    })
    assert.equal(resume.status, 0, resume.stderr)
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")).arguments.slice(-2), ["resume", "session-id"])

    assert.equal(run(adapter, ["exec"], {CAPTURE_FILE: capture}).status, 2)
    assert.equal(run(adapter, ["exec", "--cd=/tmp"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    }).status, 2)
    assert.equal(run(adapter, ["exec", "-C/tmp"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    }).status, 2)
    assert.equal(run(adapter, ["exec", "-c", "sandbox_mode=\"danger-full-access\""], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    }).status, 2)
    assert.equal(run(adapter, ["resume", "--remote=ws://elsewhere.invalid"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    }).status, 2)
  })

  it("forwards termination signals to the lifecycle child", async () => {
    const {adapter, capture, ready, signal} = providerFixture(true)
    const child = spawn(adapter, ["exec", "--json"], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        CAPTURE_FILE: capture,
        READY_FILE: ready,
        SIGNAL_FILE: signal,
        THREADWIRE_ACTIVE: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    })
    child.stdin.end()

    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(existsSync(ready), "provider child did not become ready")
    child.kill("SIGTERM")

    const completion = await new Promise((resolve) => {
      child.once("close", (code, childSignal) => resolve({code, signal: childSignal}))
    })
    assert.ok(completion.code !== 0 || completion.signal, "provider unexpectedly ignored SIGTERM")
    assert.equal(readFileSync(signal, "utf8"), "SIGTERM\n")
  })
})

describe("Hermes infrastructure invariants", () => {
  it("keeps source out of the image and uses a pinned non-root Node 24 toolchain", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile.hermes"), "utf8")

    assert.match(dockerfile, /^FROM node:24\.18\.0-bookworm$/m)
    assert.match(dockerfile, /@openai\/codex@\$\{CODEX_VERSION\}/)
    assert.match(dockerfile, /\bgh\b/)
    assert.match(dockerfile, /\bbuild-essential\b/)
    assert.match(dockerfile, /io\.snapreq\.hermes\.project/)
    assert.match(dockerfile, /^USER node$/m)
    assert.doesNotMatch(dockerfile, /^(COPY|ADD)\s/im)
  })

  it("has one exact source bind and only project-scoped mutable resources", () => {
    const compose = readFileSync(path.join(repoRoot, "compose.hermes.yml"), "utf8")

    assert.equal((compose.match(/type: bind/g) || []).length, 1)
    assert.match(compose, /source: \$\{SNAPREQ_SOURCE_PATH:\?/)
    assert.match(compose, /create_host_path: false/)
    assert.match(compose, /name: \$\{SNAPREQ_COMPOSE_PROJECT:\?/)
    assert.match(compose, /source: node_modules/)
    assert.match(compose, /source: npm_cache/)
    assert.match(compose, /source: codex_home/)
    assert.match(compose, /io\.snapreq\.hermes\.project/)
    assert.doesNotMatch(compose, /container_name:|host_ip:|published:|ports:|\/opt\/data|docker\.sock|safe\.directory/)
  })

  it("keeps the complete smoke acceptance sequence and exact resource names", () => {
    const smokeSource = readFileSync(smoke, "utf8")

    for (const requiredValue of [
      "build",
      "--pull",
      "--no-cache",
      "all-checks",
      "threadwire",
      "stack-b-survived",
      "SNAPREQ_PURGE_PROJECT",
      "node_modules",
      "npm_cache",
      "codex_home",
      "_default",
      "-dev"
    ]) {
      assert.match(smokeSource, new RegExp(requiredValue))
    }
    assert.doesNotMatch(smokeSource, /docker cp|container_name|--volumes-from|\/opt\/data/)
  })
})

describe("Hermes JavaScript safety behavior", () => {
  it("fails closed on container list and inspect errors before checkout deletion", async () => {
    const {HermesSmokeSafety} = await importScript(smoke)
    let deletionReached = false

    for (const scenario of ["list-failure", "inspect-failure"]) {
      const runner = {
        capture(command, arguments_) {
          assert.equal(command, "docker")
          if (arguments_[0] === "container" && arguments_[1] === "ls") {
            if (scenario === "list-failure") throw new Error("list failed")
            return "container-1\n"
          }
          if (arguments_[0] === "container" && arguments_[1] === "inspect") {
            throw new Error("inspect failed")
          }
          throw new Error(`unexpected command: ${arguments_.join(" ")}`)
        }
      }
      const safety = new HermesSmokeSafety({runner})
      assert.throws(() => {
        safety.assertNoContainerPathReferences("/exact/task-checkout")
        deletionReached = true
      })
      assert.equal(deletionReached, false)
    }

    const emptyList = new HermesSmokeSafety({
      runner: {capture: () => ""}
    })
    assert.doesNotThrow(() => emptyList.assertNoContainerPathReferences("/exact/task-checkout"))

    const emptyMounts = new HermesSmokeSafety({
      runner: {
        capture(command, arguments_) {
          return arguments_[1] === "ls" ? "container-1\n" : ""
        }
      }
    })
    assert.doesNotThrow(() => emptyMounts.assertNoContainerPathReferences("/exact/task-checkout"))
  })

  it("preserves exact source-path comparison when checking container mounts", async () => {
    const {HermesSmokeSafety} = await importScript(smoke)
    const safety = new HermesSmokeSafety({
      runner: {
        capture(command, arguments_) {
          return arguments_[1] === "ls"
            ? "container-1\n"
            : "/exact/task-checkout-other\n/exact/task-checkout\n"
        }
      }
    })

    assert.throws(
      () => safety.assertNoContainerPathReferences("/exact/task-checkout"),
      /container-1 still references/
    )
  })

  it("rejects each existing or unqueryable task resource before allocation", async () => {
    const {HermesSmokeSafety} = await importScript(smoke)
    const project = "snapreq-review-test"
    const scenarios = [
      "container",
      "volume-exact",
      "volume-labeled",
      "network-exact",
      "network-labeled",
      "image-exact",
      "image-labeled",
      "fail-container",
      "fail-volume-names",
      "fail-volume-labels",
      "fail-network-names",
      "fail-network-labels",
      "fail-image-names",
      "fail-image-labels"
    ]

    for (const scenario of scenarios) {
      let allocationReached = false
      const safety = new HermesSmokeSafety({
        runner: {
          capture(command, arguments_) {
            const resource = arguments_[0]
            const option = arguments_[2]
            const query = `${resource}:${option}`
            if (scenario === `fail-${resource}-${option === "--format" ? "names" : "labels"}`) {
              throw new Error(`${query} failed`)
            }
            if (scenario === "fail-container" && resource === "container") throw new Error("container failed")
            if (scenario === "container" && resource === "container") return "container-1\n"
            if (scenario === "volume-exact" && query === "volume:--format") return `${project}_node_modules\n`
            if (scenario === "volume-labeled" && query === "volume:--quiet") return "volume-1\n"
            if (scenario === "network-exact" && query === "network:--format") return `${project}_default\n`
            if (scenario === "network-labeled" && query === "network:--quiet") return "network-1\n"
            if (scenario === "image-exact" && query === "image:--format") return `${project}-dev\n`
            if (scenario === "image-labeled" && query === "image:--quiet") return "image-1\n"
            return ""
          }
        }
      })

      assert.throws(() => {
        safety.assertProjectResourcesAbsent(project)
        allocationReached = true
      }, scenario)
      assert.equal(allocationReached, false, `${scenario} reached allocation`)
    }

    const clean = new HermesSmokeSafety({runner: {capture: () => ""}})
    assert.doesNotThrow(() => clean.assertProjectResourcesAbsent(project))
  })

  it("builds narrow ownership, cleanup, and bootstrap Docker argument arrays", async () => {
    const {HermesSmoke} = await importScript(smoke)
    const instance = new HermesSmoke({
      bootstrapImage: "snapreq-source-dev",
      runner: {capture: () => "", run: async () => {}},
      sourceRepo: "/exact/source"
    })

    const ownership = instance.destinationOwnershipArguments("/exact/destination")
    assert.deepEqual(ownership.slice(0, 14), [
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
      "--security-opt"
    ])
    assert.equal(ownership.filter((argument) => argument === "--mount").length, 2)
    assert.ok(ownership.includes("type=bind,src=/exact/source,dst=/source,readonly"))
    assert.ok(ownership.includes("type=bind,src=/exact/destination,dst=/destination"))
    assert.doesNotMatch(ownership.join("\n"), /\/opt\/hermes-dind-shared/)
    assert.ok(ownership.includes("HERMES_SMOKE_HELPER=1"))
    assert.ok(ownership.includes("HERMES_SMOKE_HELPER_MODE=destination-ownership"))
    assert.equal(ownership.filter((argument) => argument === "--cap-add").length, 2)
    assert.ok(!ownership.includes("--privileged"))
    assert.deepEqual(ownership.slice(-3), [
      "node",
      "/source/scripts/hermes-smoke.js",
      "_helper-destination-ownership"
    ])
    assert.ok(!ownership.includes("--eval"))
    assert.ok(!ownership.includes("--input-type=module"))

    const cleanup = instance.checkoutCleanupArguments("/exact/destination")
    assert.deepEqual(cleanup.slice(0, 10), [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt"
    ])
    assert.equal(cleanup.filter((argument) => argument === "--mount").length, 2)
    assert.ok(cleanup.includes("type=bind,src=/exact/source,dst=/source,readonly"))
    assert.ok(cleanup.includes("type=bind,src=/exact/destination,dst=/destination"))
    assert.ok(cleanup.includes("HERMES_SMOKE_HELPER=1"))
    assert.ok(cleanup.includes("HERMES_SMOKE_HELPER_MODE=checkout-cleanup"))
    assert.ok(!cleanup.includes("--cap-add"))
    assert.ok(!cleanup.includes("--privileged"))
    assert.deepEqual(cleanup.slice(-3), [
      "node",
      "/source/scripts/hermes-smoke.js",
      "_helper-checkout-cleanup"
    ])
    assert.ok(!cleanup.includes("--eval"))
    assert.ok(!cleanup.includes("--input-type=module"))

    const bootstrap = instance.bootstrapArguments("/exact/destination", "hermes-smoke/task", "snapreq-task")
    assert.equal(bootstrap.filter((argument) => argument === "--mount").length, 2)
    assert.ok(bootstrap.includes("type=bind,src=/exact/source,dst=/source,readonly"))
    assert.ok(bootstrap.includes("type=bind,src=/exact/destination,dst=/destination"))
    assert.ok(bootstrap.includes("/source/scripts/hermes-smoke-bootstrap.js"))
  })

  it("behaviorally removes a checkout tree without removing its destination root", async () => {
    const {HermesSmokeCheckoutHelper} = await importScript(smoke)
    const fixture = path.join(temporaryRoot, "checkout-helper-removal")
    const destination = path.join(fixture, "destination")
    const nested = path.join(destination, "nested", "deeper")
    const externalFile = path.join(fixture, "outside.txt")

    mkdirSync(nested, {recursive: true})
    writeFileSync(path.join(destination, "root.txt"), "root\n")
    writeFileSync(path.join(nested, "nested.txt"), "nested\n")
    writeFileSync(externalFile, "outside\n")
    symlinkSync(externalFile, path.join(destination, "outside-link"))
    symlinkSync("../root.txt", path.join(destination, "nested", "inside-link"))

    const helper = new HermesSmokeCheckoutHelper({
      destination,
      environment: {
        HERMES_SMOKE_HELPER: "1",
        HERMES_SMOKE_HELPER_MODE: "checkout-cleanup"
      },
      getgid: () => 1000,
      getuid: () => 1000,
      mountInfoReader: () => "1 0 0:1 / / rw - ext4 /dev/root rw\n"
    })
    helper.main(["_helper-checkout-cleanup"])

    assert.deepEqual(readdirSync(destination), [])
    assert.equal(readFileSync(externalFile, "utf8"), "outside\n")

    const protectedFile = path.join(destination, "marker-protected.txt")
    writeFileSync(protectedFile, "protected\n")
    for (const [environment, arguments_] of [
      [{}, ["_helper-checkout-cleanup"]],
      [
        {
          HERMES_SMOKE_HELPER: "1",
          HERMES_SMOKE_HELPER_MODE: "destination-ownership"
        },
        ["_helper-checkout-cleanup"]
      ],
      [
        {
          HERMES_SMOKE_HELPER: "1",
          HERMES_SMOKE_HELPER_MODE: "checkout-cleanup"
        },
        ["_helper-checkout-cleanup", "unexpected"]
      ]
    ]) {
      const rejectedHelper = new HermesSmokeCheckoutHelper({
        destination,
        environment,
        getgid: () => 1000,
        getuid: () => 1000,
        mountInfoReader: () => "1 0 0:1 / / rw - ext4 /dev/root rw\n"
      })
      assert.throws(() => rejectedHelper.main(arguments_))
      assert.equal(readFileSync(protectedFile, "utf8"), "protected\n")
    }
  })

  it("fails closed before deleting when mountinfo is nested, malformed, or unreadable", async () => {
    const {HermesSmokeCheckoutHelper} = await importScript(smoke)

    for (const scenario of ["nested", "malformed", "unreadable"]) {
      const destination = path.join(temporaryRoot, `checkout-helper-${scenario}`)
      const nested = path.join(destination, "nested")
      const protectedFile = path.join(nested, "protected.txt")
      mkdirSync(nested, {recursive: true})
      writeFileSync(protectedFile, `${scenario}\n`)

      const mountInfoReader = scenario === "nested"
        ? () => [
            "1 0 0:1 / / rw - ext4 /dev/root rw",
            `2 1 0:1 /nested ${nested} rw - ext4 /dev/root rw`,
            ""
          ].join("\n")
        : scenario === "malformed"
          ? () => "malformed mountinfo\n"
          : () => {
              throw Object.assign(new Error("mountinfo unreadable"), {code: "EACCES"})
            }
      const helper = new HermesSmokeCheckoutHelper({
        destination,
        environment: {
          HERMES_SMOKE_HELPER: "1",
          HERMES_SMOKE_HELPER_MODE: "checkout-cleanup"
        },
        getgid: () => 1000,
        getuid: () => 1000,
        mountInfoReader
      })

      assert.throws(() => helper.main(["_helper-checkout-cleanup"]))
      assert.equal(readFileSync(protectedFile, "utf8"), `${scenario}\n`)
    }
  })

  it("represents uid-1000 ownership and parses checkout identity without native checkout assumptions", async () => {
    const {HermesComposeCli} = await importScript(lifecycle)
    const checkout = path.join(temporaryRoot, "represented-checkout")
    const gitDirectory = path.join(checkout, ".git")
    const head = "0123456789abcdef0123456789abcdef01234567"

    mkdirSync(path.join(gitDirectory, "refs/heads"), {recursive: true})
    chmodSync(checkout, 0o755)
    chmodSync(gitDirectory, 0o755)
    writeFileSync(path.join(gitDirectory, "config"), [
      "[remote \"origin\"]",
      "\turl = https://github.com/kaspernj/snapreq.git",
      ""
    ].join("\n"))
    writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/task-10575-hermes-compose\n")
    writeFileSync(path.join(gitDirectory, "refs/heads/task-10575-hermes-compose"), `${head}\n`)

    /**
     * Represents checkout ownership independently from the native fixture uid.
     * @param {{root?: number, git?: number}} owners - Represented owner ids.
     * @returns {object} - Injectable filesystem boundary.
     */
    function representedFileSystem(owners = {}) {
      return {
        existsSync,
        lstatSync: (...arguments_) => statSync(...arguments_),
        readFileSync,
        realpathSync: (value) => path.resolve(value),
        statSync(value) {
          const actual = statSync(value)
          const representedOwner = value === gitDirectory ? owners.git ?? 1000 : owners.root ?? 1000
          return new Proxy(actual, {
            get(target, property) {
              if (property === "uid" || property === "gid") return representedOwner
              return Reflect.get(target, property, target)
            }
          })
        }
      }
    }

    const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid")
    const originalGetgid = Object.getOwnPropertyDescriptor(process, "getgid")
    Object.defineProperties(process, {
      getuid: {...originalGetuid, value: () => 10000},
      getgid: {...originalGetgid, value: () => 10000}
    })
    try {
      const cli = new HermesComposeCli({fileSystem: representedFileSystem()})
      assert.equal(process.getuid(), 10000)
      assert.equal(process.getgid(), 10000)
      assert.doesNotThrow(() => cli.validateCheckoutOwnership(checkout))
      assert.deepEqual(cli.readCheckoutIdentity(checkout), {
        head,
        origin: "https://github.com/kaspernj/snapreq.git"
      })
    } finally {
      Object.defineProperties(process, {
        getuid: originalGetuid,
        getgid: originalGetgid
      })
    }

    for (const owners of [{root: 10000}, {git: 10000}]) {
      const wrongOwner = new HermesComposeCli({fileSystem: representedFileSystem(owners)})
      assert.throws(
        () => wrongOwner.validateCheckoutOwnership(checkout),
        /must be owned by uid\/gid 1000:1000 \(found 10000:10000\)/
      )
    }
  })

  it("uses explicit auth volume validation and no outer auth file", () => {
    const valid = run(lifecycle, ["_validate-auth-volume-name", "hermes-auth_10575"])
    assert.equal(valid.status, 0, valid.stderr)

    for (const invalidName of ["a", "-auth", "../auth", "/auth", "auth:ro", "auth volume", "UPPER"]) {
      const invalid = run(lifecycle, ["_validate-auth-volume-name", invalidName])
      assert.equal(invalid.status, 2, `${invalidName} unexpectedly passed`)
    }

    const lifecycleSource = readFileSync(lifecycle, "utf8")
    const compose = readFileSync(path.join(repoRoot, "compose.hermes.yml"), "utf8")
    assert.match(lifecycleSource, /SNAPREQ_CODEX_AUTH_VOLUME/)
    assert.match(lifecycleSource, /\/source\/auth\.json/)
    assert.doesNotMatch(lifecycleSource, /SNAPREQ_CODEX_AUTH_FILE|codex-auth\.json/)
    assert.doesNotMatch(compose, /SNAPREQ_CODEX_AUTH_VOLUME|\/source\/auth\.json/)
  })

  it("keeps Git mutation inside the JavaScript bootstrap container entry point", async () => {
    const smokeSource = readFileSync(smoke, "utf8")
    const bootstrapSource = readFileSync(smokeBootstrap, "utf8")
    const {SmokeBootstrap} = await importScript(smokeBootstrap)

    assert.equal(typeof SmokeBootstrap, "function")
    assert.doesNotMatch(smokeSource, /\bspawn(?:Sync)?\([^)]*["']git["']/)
    assert.match(bootstrapSource, /\["clone", "--no-local", "--no-checkout", "\/source", "\/destination"\]/)
    assert.match(bootstrapSource, /\["-C", "\/destination", "add", "\.hermes-smoke-marker"\]/)
    assert.match(bootstrapSource, /SnapReq Hermes Smoke/)

    for (const source of [smokeSource, bootstrapSource]) {
      assert.doesNotMatch(source, /docker cp|\btar\b|\bzip\b|\bunzip\b/)
    }
  })
})
