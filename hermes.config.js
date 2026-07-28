export default {
  repository: {
    name: "snapreq",
    slug: "kaspernj/snapreq",
    acceptedOrigins: [
      "https://github.com/kaspernj/snapreq.git",
      "https://github.com/kaspernj/snapreq",
      "git@github.com:kaspernj/snapreq.git",
      "ssh://git@github.com/kaspernj/snapreq.git"
    ]
  },
  worktree: {
    root: "/opt/hermes-dind-shared/worktrees/snapreq"
  },
  project: {
    prefix: "snapreq"
  },
  compose: {
    file: "compose.hermes.yml",
    dockerfile: "Dockerfile.hermes",
    service: "dev",
    workspace: "/workspace"
  },
  identity: {
    uid: 1000,
    gid: 1000
  },
  volumes: [
    {
      name: "node_modules",
      purpose: "node_modules",
      target: "/workspace/node_modules"
    },
    {
      name: "npm_cache",
      purpose: "npm_cache",
      target: "/home/node/.npm"
    },
    {
      name: "codex_home",
      purpose: "codex_home",
      target: "/home/node/.codex"
    }
  ],
  labels: {
    namespace: "io.kaspernj.hermes-compose"
  },
  proof: {
    checksumFiles: [
      "compose.hermes.yml",
      "Dockerfile.hermes"
    ]
  },
  checks: [
    ["npm", "run", "all-checks"]
  ],
  smoke: {
    branchPrefix: "hermes-smoke/",
    markerFile: ".hermes-smoke-marker",
    markerTemplate: "stack={project}\n"
  },
  worker: {
    bootstrapCli: "/usr/local/bin/hermes-compose",
    codexCommand: "codex",
    containerCli: "/workspace/node_modules/.bin/hermes-compose",
    threadwireCommand: "threadwire"
  }
}
