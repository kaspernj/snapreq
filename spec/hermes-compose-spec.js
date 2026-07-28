// @ts-check

import assert from "node:assert/strict"
import {existsSync, readFileSync, statSync} from "node:fs"
import {fileURLToPath} from "node:url"
import path from "node:path"
import {describe, it} from "node:test"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"))
const dependencyName = "@kaspernj/hermes-compose"
const dependencyPath = `node_modules/${dependencyName}`
const expectedVersion = "0.0.0"

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8")
}

describe("shared Hermes Compose package", () => {
  it("is an exact development-only dependency with lockfile integrity", () => {
    assert.equal(packageJson.devDependencies[dependencyName], expectedVersion)
    assert.equal(packageJson.dependencies?.[dependencyName], undefined)
    assert.equal(packageLock.packages[""].devDependencies[dependencyName], expectedVersion)

    const locked = packageLock.packages[dependencyPath]
    assert.equal(locked.version, expectedVersion)
    assert.equal(locked.dev, true)
    assert.equal(
      locked.resolved,
      "https://registry.npmjs.org/@kaspernj/hermes-compose/-/hermes-compose-0.0.0.tgz"
    )
    assert.equal(
      locked.integrity,
      "sha512-tA3DS8MxnGDoBiicoFwDqZ1Dk9BzYf1JvFk2QMyWsEPZr0NFp0q7s+ZYTX6ddu6gd0cW5141JRZKyBkdEsCbng=="
    )
  })

  it("exposes the documented public API and installed command binaries", async () => {
    const publicApi = await import(dependencyName)
    for (const exportName of [
      "createLifecycle",
      "createSmoke",
      "HermesLifecycle",
      "HermesSmoke",
      "loadConfig",
      "runCli",
      "startCli",
      "validateConfig"
    ]) {
      assert.equal(typeof publicApi[exportName], "function", `missing public export ${exportName}`)
    }

    for (const binary of ["hermes-compose", "hermes-compose-threadwire-provider"]) {
      const binaryPath = path.join(repoRoot, "node_modules", ".bin", binary)
      assert.ok(existsSync(binaryPath), `missing ${binary}`)
      assert.ok(statSync(binaryPath).mode & 0o100, `${binary} must be executable`)
    }
  })
})

describe("SnapReq Hermes consumer configuration", () => {
  it("loads and validates the checked-in config in an isolated environment", async () => {
    const {loadConfig} = await import(dependencyName)
    const config = await loadConfig({
      root: repoRoot,
      environment: {
        PATH: process.env.PATH || "/usr/bin:/bin"
      }
    })

    assert.deepEqual(config.repository, {
      name: "snapreq",
      slug: "kaspernj/snapreq",
      acceptedOrigins: [
        "https://github.com/kaspernj/snapreq.git",
        "https://github.com/kaspernj/snapreq",
        "git@github.com:kaspernj/snapreq.git",
        "ssh://git@github.com/kaspernj/snapreq.git"
      ]
    })
    assert.deepEqual(config.worktree, {
      root: "/opt/hermes-dind-shared/worktrees/snapreq"
    })
    assert.deepEqual(config.project, {prefix: "snapreq"})
    assert.deepEqual(config.compose, {
      file: "compose.hermes.yml",
      filePath: path.join(repoRoot, "compose.hermes.yml"),
      dockerfile: "Dockerfile.hermes",
      dockerfilePath: path.join(repoRoot, "Dockerfile.hermes"),
      service: "dev",
      workspace: "/workspace"
    })
    assert.deepEqual(config.identity, {uid: 1000, gid: 1000})
    assert.deepEqual(config.volumes, [
      {name: "node_modules", purpose: "node_modules", target: "/workspace/node_modules"},
      {name: "npm_cache", purpose: "npm_cache", target: "/home/node/.npm"},
      {name: "codex_home", purpose: "codex_home", target: "/home/node/.codex"}
    ])
    assert.deepEqual(config.labels, {namespace: "io.kaspernj.hermes-compose"})
    assert.deepEqual(config.proof, {
      checksumFiles: ["compose.hermes.yml", "Dockerfile.hermes"]
    })
    assert.deepEqual(config.checks, [["npm", "run", "all-checks"]])
    assert.deepEqual(config.smoke, {
      branchPrefix: "hermes-smoke/",
      markerFile: ".hermes-smoke-marker",
      markerTemplate: "stack={project}\n"
    })
    assert.deepEqual(config.worker, {
      bootstrapCli: "/usr/local/bin/hermes-compose",
      codexCommand: "codex",
      containerCli: "/workspace/node_modules/.bin/hermes-compose",
      threadwireCommand: "threadwire"
    })
    assert.ok(Object.isFrozen(config))
  })

  it("uses generic package-pinned Compose and Dockerfile wiring", () => {
    const compose = read("compose.hermes.yml")
    const dockerfile = read("Dockerfile.hermes")

    assert.match(compose, /^name: \$\{HERMES_COMPOSE_PROJECT:\?/m)
    assert.match(compose, /source: \$\{HERMES_SOURCE_PATH:\?/)
    assert.match(compose, /PACKAGE_VERSION: "0\.0\.0"/)
    assert.match(compose, /user: "1000:1000"/)
    assert.match(compose, /io\.kaspernj\.hermes-compose\.service: dev/)
    assert.match(compose, /io\.kaspernj\.hermes-compose\.network: default/)
    for (const purpose of ["node_modules", "npm_cache", "codex_home"]) {
      assert.match(compose, new RegExp(`io\\.kaspernj\\.hermes-compose\\.purpose: ${purpose}`))
    }
    assert.doesNotMatch(compose, /\b(?:ports|container_name):|docker\.sock/)

    assert.match(dockerfile, /^FROM node:24\.\d+\.\d+-bookworm$/m)
    assert.match(dockerfile, /ARG PACKAGE_VERSION=0\.0\.0/)
    assert.match(dockerfile, /@kaspernj\/hermes-compose@\$\{PACKAGE_VERSION\}/)
    assert.match(dockerfile, /io\.kaspernj\.hermes-compose\.image="dev"/)
    assert.match(dockerfile, /^USER node$/m)
  })
})

describe("SnapReq owns wiring rather than lifecycle implementation", () => {
  it("has no local scripts directory or stale active wiring", () => {
    assert.equal(existsSync(path.join(repoRoot, "scripts")), false)
    assert.equal(packageJson.scripts.eslint, "eslint src spec")
    assert.equal(packageJson.scripts["hermes:check"], "node --test spec/hermes-compose-spec.js")

    const integrationFiles = [
      "AGENTS.md",
      "Dockerfile.hermes",
      "README.md",
      "compose.hermes.yml",
      "eslint.config.js",
      "hermes.config.js",
      "package-lock.json",
      "package.json"
    ]
    for (const file of integrationFiles) {
      const source = read(file)
      assert.doesNotMatch(source, /SNAPREQ_|io\.snapreq\.hermes/, file)
      assert.doesNotMatch(
        source,
        /scripts\/(?:hermes-command|hermes-compose|hermes-smoke|hermes-smoke-bootstrap|threadwire-compose-provider)(?:\.js)?/,
        file
      )
    }
  })

  it("documents package ownership and safe package CLI usage", () => {
    const documentation = `${read("README.md")}\n${read("AGENTS.md")}`

    assert.match(documentation, /@kaspernj\/hermes-compose/)
    assert.match(documentation, /package owns (?:the )?lifecycle/i)
    const outerCli = "npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose"
    assert.ok(documentation.includes(`${outerCli} validate`))
    assert.ok(documentation.includes(`${outerCli} smoke`))
    assert.doesNotMatch(documentation, /\.\/node_modules\/\.bin\/hermes-compose/)
    assert.match(documentation, /Do not use .*Docker socket.*`docker cp`/s)
  })
})
