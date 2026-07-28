// @ts-check

import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import path from "node:path"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const lifecycle = path.join(repoRoot, "scripts/hermes-compose")
const provider = path.join(repoRoot, "scripts/threadwire-compose-provider")
const smoke = path.join(repoRoot, "scripts/hermes-smoke")
const smokeBootstrap = path.join(repoRoot, "scripts/hermes-smoke-bootstrap")
const scripts = [lifecycle, provider, smoke, smokeBootstrap]
let temporaryRoot

/**
 * Runs a command without inheriting credential-bearing environment variables.
 * @param {string} command - Executable path.
 * @param {string[]} arguments_ - Argument vector.
 * @param {Record<string, string>} [extraEnvironment] - Explicit safe environment additions.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} - Completed child result.
 */
function run(command, arguments_, extraEnvironment = {}) {
  return spawnSync(command, arguments_, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...extraEnvironment
    }
  })
}

before(() => {
  const taskTemp = path.join(repoRoot, "tmp")
  mkdirSync(taskTemp, {recursive: true})
  temporaryRoot = mkdtempSync(path.join(taskTemp, "hermes-compose-spec-"))
})

after(() => {
  if (temporaryRoot) rmSync(temporaryRoot, {recursive: true, force: true})
})

describe("Hermes shell entry points", () => {
  it("are executable strict Bash scripts with valid syntax", () => {
    for (const script of scripts) {
      assert.ok(statSync(script).mode & 0o100, `${path.basename(script)} must be executable`)
      assert.match(readFileSync(script, "utf8"), /^#!\/usr\/bin\/env bash\n\nset -Eeuo pipefail/m)

      const result = run("bash", ["-n", script])
      assert.equal(result.status, 0, result.stderr)
    }
  })

  it("accepts only matching, normalized project/task pairs", () => {
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
   * Installs the provider beside a capture-only lifecycle stand-in.
   * @returns {{adapter: string, capture: string}} - Fixture paths.
   */
  function providerFixture() {
    const fixture = path.join(temporaryRoot, `provider-${Math.random().toString(16).slice(2)}`)
    const fixtureScripts = path.join(fixture, "scripts")
    const adapter = path.join(fixtureScripts, "threadwire-compose-provider")
    const helper = path.join(fixtureScripts, "hermes-compose")
    const capture = path.join(fixture, "argv")

    mkdirSync(fixtureScripts, {recursive: true})
    copyFileSync(provider, adapter)
    writeFileSync(helper, [
      "#!/usr/bin/env bash",
      "set -Eeuo pipefail",
      "printf '%s\\0' \"$@\" > \"$CAPTURE_FILE\"",
      ""
    ].join("\n"), {mode: 0o755})
    chmodSync(adapter, 0o755)

    return {adapter, capture}
  }

  it("injects bypass and /workspace before Threadwire exec arguments", () => {
    const {adapter, capture} = providerFixture()
    const result = run(adapter, ["exec", "--json", "-"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    })

    assert.equal(result.status, 0, result.stderr)
    const arguments_ = readFileSync(capture).toString().split("\0").filter(Boolean)
    assert.deepEqual(arguments_, [
      "provider-exec",
      "codex",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      "/workspace",
      "exec",
      "--json",
      "-"
    ])
  })

  it("supports resume ordering and rejects direct or boundary-changing calls", () => {
    const {adapter, capture} = providerFixture()
    const resume = run(adapter, ["resume", "session-id"], {
      CAPTURE_FILE: capture,
      THREADWIRE_ACTIVE: "1"
    })
    assert.equal(resume.status, 0, resume.stderr)
    assert.deepEqual(
      readFileSync(capture).toString().split("\0").filter(Boolean).slice(-2),
      ["resume", "session-id"]
    )

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

  it("checks two real stacks, routed probes, isolation, and exact cleanup", () => {
    const smokeSource = readFileSync(smoke, "utf8")

    assert.match(smokeSource, /build --pull --no-cache/)
    assert.match(smokeSource, /npm run all-checks/)
    assert.match(smokeSource, /threadwire --prompt/)
    assert.match(smokeSource, /git rev-parse HEAD/)
    assert.match(smokeSource, /package\.json/)
    assert.match(smokeSource, /dependency-volume/)
    assert.match(smokeSource, /stack-b-survived/)
    assert.match(smokeSource, /SNAPREQ_PURGE_PROJECT/)
    assert.doesNotMatch(smokeSource, /docker cp|container_name|--volumes-from|\/opt\/data/)
  })
})

describe("Hermes reviewed boundary repairs", () => {
  it("allocates a uid-1000 smoke destination through a narrow root helper from a non-1000 gateway", () => {
    const smokeSource = readFileSync(smoke, "utf8")
    const helperStart = smokeSource.indexOf("initialize_destination_ownership() {")
    const helperEnd = smokeSource.indexOf("\n}\n\ncreate_empty_destination() {", helperStart)
    const createStart = smokeSource.indexOf("create_empty_destination() {")
    const createEnd = smokeSource.indexOf("\n}\n\nremove_empty_destination() {", createStart)

    assert.notEqual(helperStart, -1, "missing destination ownership helper")
    assert.notEqual(helperEnd, -1, "destination ownership helper is not independently scoped")
    assert.notEqual(createStart, -1, "missing destination allocator")
    assert.notEqual(createEnd, -1, "destination allocator is not independently scoped")

    const helperSource = smokeSource.slice(helperStart, helperEnd)
    const createSource = smokeSource.slice(createStart, createEnd)
    assert.match(helperSource, /docker run/)
    assert.match(helperSource, /--user 0:0/)
    assert.match(helperSource, /--network none/)
    assert.match(helperSource, /--read-only/)
    assert.match(helperSource, /--cap-drop ALL/)
    assert.match(helperSource, /--cap-add CHOWN/)
    assert.match(helperSource, /--cap-add FOWNER/)
    assert.match(helperSource, /--security-opt no-new-privileges:true/)
    assert.equal((helperSource.match(/--mount/g) || []).length, 1)
    assert.match(helperSource, /src=\$destination_path,dst=\/destination/)
    assert.match(helperSource, /chown 1000:1000 -- \/destination/)
    assert.match(helperSource, /chmod 0755 -- \/destination/)
    assert.doesNotMatch(helperSource, /source_repo|SNAPREQ_CODEX_AUTH|dst=\/source|dst=\/opt\/hermes-dind-shared/)

    const mkdirIndex = createSource.indexOf('mkdir --mode=0755 -- "$destination_path"')
    const cleanupFlagIndex = createSource.indexOf("created_result=1")
    const helperCallIndex = createSource.indexOf('initialize_destination_ownership "$destination_path"')
    const cleanupStart = smokeSource.indexOf("emergency_cleanup() {")
    const cleanupEnd = smokeSource.indexOf("\n}\ntrap emergency_cleanup EXIT", cleanupStart)
    const trapIndex = smokeSource.indexOf("trap emergency_cleanup EXIT")
    const allocationIndex = smokeSource.indexOf('create_empty_destination "$path_a" created_a')
    assert.ok(mkdirIndex >= 0, "outer allocator must create only the exact empty directory")
    assert.ok(cleanupFlagIndex > mkdirIndex, "cleanup flag must follow successful mkdir")
    assert.ok(helperCallIndex > cleanupFlagIndex, "cleanup must cover ownership-helper failure")
    assert.doesNotMatch(createSource, /\bchown\b/, "the outer gateway must not change ownership")
    assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "missing scoped emergency cleanup")
    assert.ok(trapIndex >= 0 && allocationIndex > trapIndex, "cleanup trap must precede allocation")
    const cleanupSource = smokeSource.slice(cleanupStart, cleanupEnd)
    assert.match(cleanupSource, /created_a == 1.*sha_a.*remove_empty_destination "\$path_a"/s)
    assert.match(cleanupSource, /created_b == 1.*sha_b.*remove_empty_destination "\$path_b"/s)
  })

  it("removes uid-1000 smoke checkouts through a narrow non-root helper", () => {
    const smokeSource = readFileSync(smoke, "utf8")
    const removeStart = smokeSource.indexOf("remove_checkout() {")
    const removeEnd = smokeSource.indexOf("\n}\n\ninitialize_destination_ownership() {", removeStart)
    const emptyStart = smokeSource.indexOf("remove_empty_destination() {")
    const emptyEnd = smokeSource.indexOf("\n}\n\nbootstrap_checkout() {", emptyStart)

    assert.notEqual(removeStart, -1, "missing checkout removal helper")
    assert.notEqual(removeEnd, -1, "checkout removal helper is not independently scoped")
    assert.notEqual(emptyStart, -1, "missing empty destination removal helper")
    assert.notEqual(emptyEnd, -1, "empty destination removal helper is not independently scoped")

    const removeSource = smokeSource.slice(removeStart, removeEnd)
    const emptySource = smokeSource.slice(emptyStart, emptyEnd)
    assert.match(smokeSource, /bootstrap_image="\$\{source_project\}-dev"/)
    assert.match(smokeSource, /docker image inspect --format .*"\$bootstrap_image"/)
    assert.match(removeSource, /realpath -e -- "\$source_path"/)
    assert.match(removeSource, /assert_no_container_path_references "\$source_path"/)
    assert.match(removeSource, /docker run/)
    assert.match(removeSource, /--rm/)
    assert.match(removeSource, /--user 1000:1000/)
    assert.match(removeSource, /--network none/)
    assert.match(removeSource, /--read-only/)
    assert.match(removeSource, /--cap-drop ALL/)
    assert.match(removeSource, /--security-opt no-new-privileges:true/)
    assert.equal((removeSource.match(/--mount/g) || []).length, 1)
    assert.match(removeSource, /src=\$source_path,dst=\/destination/)
    assert.match(removeSource, /"\$bootstrap_image"/)
    assert.match(removeSource, /find \/destination -xdev -mindepth 1 -delete/)
    assert.match(removeSource, /rmdir -- "\$source_path"/)
    assert.doesNotMatch(removeSource, /rm -rf[^\n]*"\$source_path"/)
    assert.doesNotMatch(removeSource, /-exec rm -rf/)
    assert.doesNotMatch(removeSource, /--user 0:0|--cap-add|\bchown\b|docker cp|dst=\/source|dst=\/opt\/hermes-dind-shared/)

    const canonicalIndex = removeSource.indexOf('realpath -e -- "$source_path"')
    const referencesIndex = removeSource.indexOf('assert_no_container_path_references "$source_path"')
    const identityIndex = removeSource.indexOf('_read-checkout-identity "$source_path"')
    const dockerIndex = removeSource.indexOf("docker run")
    const rmdirIndex = removeSource.indexOf('rmdir -- "$source_path"')
    assert.ok(canonicalIndex >= 0 && referencesIndex > canonicalIndex)
    assert.ok(identityIndex > referencesIndex && dockerIndex > identityIndex)
    assert.ok(rmdirIndex > dockerIndex)

    assert.match(emptySource, /assert_no_container_path_references "\$destination_path"/)
    assert.match(emptySource, /rmdir -- "\$destination_path"/)
    assert.doesNotMatch(emptySource, /docker run|\brm -rf\b/)
  })

  it("allows a non-1000 outer orchestrator while enforcing checkout and service ownership", () => {
    const fakeBin = path.join(temporaryRoot, "uid-10000-bin")
    const fakeId = path.join(fakeBin, "id")
    const fakeStat = path.join(fakeBin, "stat")
    const checkout = path.join(temporaryRoot, "represented-checkout")
    const gitDirectory = path.join(checkout, ".git")
    const head = "0123456789abcdef0123456789abcdef01234567"

    mkdirSync(fakeBin, {recursive: true})
    mkdirSync(path.join(gitDirectory, "refs/heads"), {recursive: true})
    writeFileSync(path.join(gitDirectory, "config"), [
      "[remote \"origin\"]",
      "\turl = https://github.com/kaspernj/snapreq.git",
      ""
    ].join("\n"))
    writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/task-10575-hermes-compose\n")
    writeFileSync(path.join(gitDirectory, "refs/heads/task-10575-hermes-compose"), `${head}\n`)
    writeFileSync(fakeId, [
      "#!/bin/sh",
      "case \"${1:-}\" in",
      "  -u) printf '10000\\n' ;;",
      "  -g) printf '10000\\n' ;;",
      "  *) printf 'uid=10000(gateway) gid=10000(gateway)\\n' ;;",
      "esac",
      ""
    ].join("\n"), {mode: 0o755})
    writeFileSync(fakeStat, [
      "#!/bin/sh",
      "case \"${4:-}\" in",
      "  \"$SNAPREQ_TEST_CHECKOUT\") owner=\"${SNAPREQ_TEST_ROOT_OWNER:-1000:1000}\" ;;",
      "  \"$SNAPREQ_TEST_CHECKOUT/.git\") owner=\"${SNAPREQ_TEST_GIT_OWNER:-1000:1000}\" ;;",
      "  *) exit 64 ;;",
      "esac",
      "case \"${1:-}:${2:-}\" in",
      "  '-c:%u:%g') printf '%s\\n' \"$owner\" ;;",
      "  '-c:%A') printf 'drwxr-xr-x\\n' ;;",
      "  *) exit 64 ;;",
      "esac",
      ""
    ].join("\n"), {mode: 0o755})

    const fakeEnvironment = {
      PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`,
      SNAPREQ_TEST_CHECKOUT: checkout
    }
    const ownership = run(lifecycle, ["_validate-checkout-ownership", checkout], fakeEnvironment)
    assert.equal(ownership.status, 0, ownership.stderr)

    for (const ownerVariable of ["SNAPREQ_TEST_ROOT_OWNER", "SNAPREQ_TEST_GIT_OWNER"]) {
      const wrongOwnership = run(lifecycle, ["_validate-checkout-ownership", checkout], {
        ...fakeEnvironment,
        [ownerVariable]: "10000:10000"
      })
      assert.equal(wrongOwnership.status, 2, `${ownerVariable} unexpectedly passed`)
      assert.match(wrongOwnership.stderr, /must be owned by uid\/gid 1000:1000 \(found 10000:10000\)/)
    }

    const identity = run(lifecycle, ["_read-checkout-identity", checkout], fakeEnvironment)
    assert.equal(identity.status, 0, identity.stderr)
    assert.equal(identity.stdout, [
      `head=${head}`,
      "origin=https://github.com/kaspernj/snapreq.git",
      ""
    ].join("\n"))

    const lifecycleSource = readFileSync(lifecycle, "utf8")
    const compose = readFileSync(path.join(repoRoot, "compose.hermes.yml"), "utf8")
    assert.doesNotMatch(lifecycleSource, /id -u.*EXPECTED_UID_GID|lifecycle must run as uid/)
    assert.match(lifecycleSource, /for checked_path in "\$checkout_path" "\$checkout_path\/\.git"/)
    assert.match(compose, /user: "1000:1000"/)
  })

  it("uses an explicit existing Docker auth volume rather than an outer auth file", () => {
    const valid = run(lifecycle, ["_validate-auth-volume-name", "hermes-auth_10575"])
    assert.equal(valid.status, 0, valid.stderr)

    for (const invalidName of ["a", "-auth", "../auth", "/auth", "auth:ro", "auth volume", "UPPER"]) {
      const invalid = run(lifecycle, ["_validate-auth-volume-name", invalidName])
      assert.equal(invalid.status, 2, `${invalidName} unexpectedly passed`)
    }

    const lifecycleSource = readFileSync(lifecycle, "utf8")
    const compose = readFileSync(path.join(repoRoot, "compose.hermes.yml"), "utf8")
    assert.match(lifecycleSource, /SNAPREQ_CODEX_AUTH_VOLUME/)
    assert.match(lifecycleSource, /docker volume inspect/)
    assert.match(lifecycleSource, /:\/source:ro/)
    assert.match(lifecycleSource, /\/source\/auth\.json/)
    assert.doesNotMatch(lifecycleSource, /SNAPREQ_CODEX_AUTH_FILE|codex-auth\.json/)
    assert.doesNotMatch(compose, /SNAPREQ_CODEX_AUTH_VOLUME|\/source\/auth\.json/)
  })

  it("runs all smoke checkout and Git mutations in a narrowly mounted bootstrap container", () => {
    assert.ok(existsSync(smokeBootstrap), "missing container-only smoke bootstrap payload")

    const smokeSource = readFileSync(smoke, "utf8")
    const bootstrapSource = readFileSync(smokeBootstrap, "utf8")
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile.hermes"), "utf8")

    assert.match(smokeSource, /docker run/)
    assert.match(smokeSource, /src=\$source_repo,dst=\/source,readonly/)
    assert.match(smokeSource, /src=\$destination_path,dst=\/destination/)
    assert.match(smokeSource, /--user 1000:1000/)
    assert.doesNotMatch(smokeSource, /\bgit\s+clone\b/)
    assert.doesNotMatch(smokeSource, /\bgit(?:\s+-C\s+(?:"[^"]+"|\S+))?\s+(add|commit|checkout|switch)\b/)
    assert.doesNotMatch(smokeSource, /\bgit(?:\s+-C\s+(?:"[^"]+"|\S+))?\s+remote\s+set-url\b/)
    assert.doesNotMatch(smokeSource, /\bgit(?:\s+-C\s+(?:"[^"]+"|\S+))?\s+worktree\s+(add|move|remove)\b/)
    assert.doesNotMatch(smokeSource, /\bgit(?:\s+-C\s+(?:"[^"]+"|\S+))?\s+branch\s+(?:-[dDmM]|--delete|--move)\b/)
    assert.doesNotMatch(smokeSource, /src=\$source_prefix|src=\/opt\/hermes-dind-shared\/worktrees\/snapreq(?:[,/])/)

    assert.match(bootstrapSource, /git clone --no-local --no-checkout \/source \/destination/)
    assert.match(bootstrapSource, /git -C \/destination add/)
    assert.match(bootstrapSource, /git -C \/destination.*commit/s)
    assert.match(bootstrapSource, /id -u.*1000/)

    for (const source of [smokeSource, bootstrapSource, dockerfile]) {
      assert.doesNotMatch(source, /docker cp|\btar\b|\bzip\b|\bunzip\b/)
    }
    assert.doesNotMatch(dockerfile, /^(COPY|ADD)\s/im)
  })
})
