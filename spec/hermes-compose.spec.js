// @ts-check

import {describe, expect, it} from "@velocious/testing"
import {existsSync, readFileSync, statSync} from "node:fs"
import {fileURLToPath} from "node:url"
import path from "node:path"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"))
const packageLock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"))
const dependencyName = "@kaspernj/hermes-compose"
const dependencyPath = `node_modules/${dependencyName}`
const expectedVersion = "0.0.0"

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8")
}

describe("SnapReq Hermes integration", () => {
  it("is an exact development-only dependency with lockfile integrity", () => {
    expect(packageJson.devDependencies[dependencyName]).toBe(expectedVersion)
    expect(packageJson.dependencies?.[dependencyName]).toBeUndefined()
    expect(packageLock.packages[""].devDependencies[dependencyName]).toBe(expectedVersion)

    const locked = packageLock.packages[dependencyPath]
    expect(locked.version).toBe(expectedVersion)
    expect(locked.dev).toBeTrue()
    expect(locked.resolved).toBe(
      "https://registry.npmjs.org/@kaspernj/hermes-compose/-/hermes-compose-0.0.0.tgz"
    )
    expect(locked.integrity).toBe(
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
      expect(typeof publicApi[exportName]).toBe("function")
    }

    for (const binary of ["hermes-compose", "hermes-compose-threadwire-provider"]) {
      const binaryPath = path.join(repoRoot, "node_modules", ".bin", binary)
      expect(existsSync(binaryPath)).toBeTrue()
      expect(statSync(binaryPath).mode & 0o100).toBeTruthy()
    }
  })

  it("loads and validates the checked-in config in an isolated environment", async () => {
    const {loadConfig} = await import(dependencyName)
    const config = await loadConfig({
      root: repoRoot,
      environment: {
        PATH: process.env.PATH || "/usr/bin:/bin"
      }
    })

    expect(config.repository).toEqual({
      name: "snapreq",
      slug: "kaspernj/snapreq",
      acceptedOrigins: [
        "https://github.com/kaspernj/snapreq.git",
        "https://github.com/kaspernj/snapreq",
        "git@github.com:kaspernj/snapreq.git",
        "ssh://git@github.com/kaspernj/snapreq.git"
      ]
    })
    expect(config.worktree).toEqual({
      root: "/opt/hermes-dind-shared/worktrees/snapreq"
    })
    expect(config.project).toEqual({prefix: "snapreq"})
    expect(config.compose).toEqual({
      file: "compose.hermes.yml",
      filePath: path.join(repoRoot, "compose.hermes.yml"),
      dockerfile: "Dockerfile.hermes",
      dockerfilePath: path.join(repoRoot, "Dockerfile.hermes"),
      service: "dev",
      workspace: "/workspace"
    })
    expect(config.identity).toEqual({uid: 1000, gid: 1000})
    expect(config.volumes).toEqual([
      {name: "node_modules", purpose: "node_modules", target: "/workspace/node_modules"},
      {name: "npm_cache", purpose: "npm_cache", target: "/home/node/.npm"},
      {name: "codex_home", purpose: "codex_home", target: "/home/node/.codex"}
    ])
    expect(config.labels).toEqual({namespace: "io.kaspernj.hermes-compose"})
    expect(config.proof).toEqual({
      checksumFiles: ["compose.hermes.yml", "Dockerfile.hermes"]
    })
    expect(config.checks).toEqual([["npm", "run", "all-checks"]])
    expect(config.smoke).toEqual({
      branchPrefix: "hermes-smoke/",
      markerFile: ".hermes-smoke-marker",
      markerTemplate: "stack={project}\n"
    })
    expect(config.worker).toEqual({
      bootstrapCli: "/usr/local/bin/hermes-compose",
      codexCommand: "codex",
      containerCli: "/workspace/node_modules/.bin/hermes-compose",
      threadwireCommand: "threadwire"
    })
    expect(Object.isFrozen(config)).toBeTrue()
  })

  it("uses generic package-pinned Compose and Dockerfile wiring", () => {
    const compose = read("compose.hermes.yml")
    const dockerfile = read("Dockerfile.hermes")

    expect(compose).toMatch(/^name: \$\{HERMES_COMPOSE_PROJECT:\?/m)
    expect(compose).toMatch(/source: \$\{HERMES_SOURCE_PATH:\?/)
    expect(compose).toMatch(/PACKAGE_VERSION: "0\.0\.0"/)
    expect(compose).toMatch(/user: "1000:1000"/)
    expect(compose).toMatch(/io\.kaspernj\.hermes-compose\.service: dev/)
    expect(compose).toMatch(/io\.kaspernj\.hermes-compose\.network: default/)
    for (const purpose of ["node_modules", "npm_cache", "codex_home"]) {
      expect(compose).toMatch(new RegExp(`io\\.kaspernj\\.hermes-compose\\.purpose: ${purpose}`))
    }
    expect(compose).not.toMatch(/\b(?:ports|container_name):|docker\.sock/)

    expect(dockerfile).toMatch(/^FROM node:24\.\d+\.\d+-bookworm$/m)
    expect(dockerfile).toMatch(/ARG PACKAGE_VERSION=0\.0\.0/)
    expect(dockerfile).toMatch(/@kaspernj\/hermes-compose@\$\{PACKAGE_VERSION\}/)
    expect(dockerfile).toMatch(/io\.kaspernj\.hermes-compose\.image="dev"/)
    expect(dockerfile).toMatch(/^USER node$/m)
  })

  it("has no local scripts directory or stale active wiring", () => {
    expect(existsSync(path.join(repoRoot, "scripts"))).toBeFalse()
    expect(packageJson.scripts.eslint).toBe("eslint src spec")
    expect(packageJson.scripts["hermes:check"]).toBe("velocious-test spec/hermes-compose.spec.js")

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
      expect(source).not.toMatch(/SNAPREQ_|io\.snapreq\.hermes/)
      expect(source).not.toMatch(
        /scripts\/(?:hermes-command|hermes-compose|hermes-smoke|hermes-smoke-bootstrap|threadwire-compose-provider)(?:\.js)?/
      )
    }
  })

  it("documents package ownership and safe package CLI usage", () => {
    const documentation = `${read("README.md")}\n${read("AGENTS.md")}`

    expect(documentation).toMatch(/@kaspernj\/hermes-compose/)
    expect(documentation).toMatch(/package owns (?:the )?lifecycle/i)
    const outerCli = "npm exec --yes --package=@kaspernj/hermes-compose@0.0.0 -- hermes-compose"
    expect(documentation.includes(`${outerCli} validate`)).toBeTrue()
    expect(documentation.includes(`${outerCli} smoke`)).toBeTrue()
    expect(documentation).not.toMatch(/\.\/node_modules\/\.bin\/hermes-compose/)
    expect(documentation).toMatch(/Do not use .*Docker socket.*`docker cp`/s)
  })
})
