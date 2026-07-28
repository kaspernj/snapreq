# SnapReq development and Hermes boundary

This file is the authoritative repository guide for agents and humans.

## Project contract

SnapReq is a pure JavaScript/TypeScript HTTP and WebSocket client with one
public contract across Node, browsers, Expo, and React Native. Keep Node-only
imports behind the existing dynamic transport boundary. Do not introduce a
barrel export, platform-specific behavior drift, support service, runtime
dependency, or public API change for infrastructure work. Node 24 LTS is the
development baseline.

## Hermes source and project allocation

Hermes work runs from an exact task worktree:

```text
/opt/hermes-dind-shared/worktrees/snapreq/<task>
```

Each task path must be a self-contained checkout with its `.git` directory
inside the exact subtree. A linked Git worktree whose `.git` file points to a
common directory outside the task path is intentionally rejected because that
common directory is not mounted. Set `SNAPREQ_SOURCE_PATH` to the canonical
task directory and
`SNAPREQ_COMPOSE_PROJECT` to exactly `snapreq-<task>`. The task component is
lowercase alphanumeric with optional internal hyphens. The wrapper rejects
symlinks, nested paths, a mismatched repository root/origin, ownership other
than uid/gid 1000 for either the source root or its `.git` directory,
world-writable source metadata, project/name mismatches, and ambiguous cleanup.
The authenticated outer gateway may run as a different uid/gid (currently
10000:10000); only the shared checkout metadata and the Compose `dev` process
must remain 1000:1000.

Parallel tasks must allocate different `<task>` worktrees and therefore
different `snapreq-<task>` projects. Compose then gives each task its own
default network, `node_modules`, npm cache, Codex home, image, and containers.
Never reuse a worktree or project name between live tasks.

## Exact lifecycle

Run these commands on the outer Hermes Docker host from the task worktree:

```sh
export SNAPREQ_SOURCE_PATH=/opt/hermes-dind-shared/worktrees/snapreq/<task>
export SNAPREQ_COMPOSE_PROJECT=snapreq-<task>

scripts/hermes-compose.js validate
scripts/hermes-compose.js config
scripts/hermes-compose.js build --pull
scripts/hermes-compose.js up
scripts/hermes-compose.js exec npm ci
scripts/hermes-compose.js proof
scripts/hermes-compose.js exec npm run all-checks
scripts/hermes-compose.js down
```

The wrapper always uses `docker compose -p "$SNAPREQ_COMPOSE_PROJECT"` and the
checked-in `compose.hermes.yml`. `proof` reports and verifies `/workspace`, the
Git root, origin, HEAD, source ownership/mode, Node/Codex versions, and the
Compose-file SHA-256. Record the host HEAD and checksum as well:

```sh
git -C "$SNAPREQ_SOURCE_PATH" rev-parse HEAD
sha256sum "$SNAPREQ_SOURCE_PATH/compose.hermes.yml"
```

`down` removes only that project's containers and network and preserves
mutable volumes. Destructive task-state cleanup is deliberately separate:

```sh
SNAPREQ_PURGE_PROJECT="$SNAPREQ_COMPOSE_PROJECT" scripts/hermes-compose.js purge
```

`purge` fails if the confirmation differs, any container still references an
expected volume, or a resource does not carry the expected Compose/task label.
Do not substitute broad Docker filters, wildcard deletion, or manual volume
names.

## Codex authentication and Threadwire routing

Initialize each task's Codex volume from one explicit, existing Docker volume
in the private DinD daemon:

```sh
export SNAPREQ_CODEX_AUTH_VOLUME=<existing-auth-volume>
scripts/hermes-compose.js init-codex
```

The volume name is explicit and strictly validated; the volume must already
exist and contain a nonempty, regular `/auth.json`. The initializer mounts that
volume read-only at `/source` only in a one-off task `dev` runner executing as
1000:1000, then installs only `/source/auth.json` into the project-owned Codex
home as `1000:1000` mode `0600`. The auth volume is never mounted into the
long-running service, and its contents must never enter source, an image,
command output, or logs.

Threadwire is the host-side control and relay process. It must not run Codex on
the host. Launch it through the checked-in adapter:

```sh
export THREADWIRE_TARGET=telegram:<chat-id>[:<thread-id>]
scripts/hermes-compose.js threadwire --prompt 'Work on the task.'
```

The wrapper sets `THREADWIRE_CODEX_BIN` to
`scripts/threadwire-compose-provider.js`. Threadwire invokes that direct provider
with `THREADWIRE_ACTIVE=1`; the adapter executes Codex only in the named
Compose `dev` service, with working directory `/workspace`, and places
`--dangerously-bypass-approvals-and-sandbox` before Threadwire's generated
`exec` or `resume` arguments. The adapter rejects direct calls and flags that
could change the working directory, sandbox, or writable roots.

No host or Hermes gateway may execute task commands. Do not use `/opt/data` as
source, a shared-root mount, Docker socket inside the dev service, `docker cp`,
archive synchronization, image-baked source, fixed host ports,
`container_name`, `safe.directory=*`, or a world-writable/chowned workaround.
Only the exact worktree bind and the project-scoped mutable volumes are
allowed.

## Required validation

After `npm ci`, run every command and require exit zero:

```sh
npm run lint
npm run test
npm run build
npm run all-checks
```

Also run `scripts/hermes-compose.js config`, a clean image build/start,
`scripts/hermes-compose.js proof`, `npm run hermes:check`, and the outer
two-stack acceptance:

```sh
export SNAPREQ_SMOKE_TASK_A=<unique-a>
export SNAPREQ_SMOKE_TASK_B=<unique-b>
export SNAPREQ_CODEX_AUTH_VOLUME=<existing-auth-volume>
export THREADWIRE_TARGET=telegram:<chat-id>[:<thread-id>]
scripts/hermes-smoke.js
```

The outer smoke process creates only two exact empty task destination
directories and never changes their ownership itself. A networkless root
helper mounts only the exact main task source read-only and one exact empty
destination at a time, gives the destination ownership 1000:1000 and mode
0755, and exits. A separate networkless bootstrap container then runs as
1000:1000, mounting only the exact source task subtree read-only and that one
exact destination task subtree writable to perform
clone/branch/marker/commit operations inside the container. The smoke script
then creates two self-contained task-owned checkouts/branches/commits/stacks,
proves their distinct Git/checksum/volume/network identities, performs real
read-only Threadwire provider probes, runs checks, removes stack A, proves
stack B is unchanged and healthy, and only then removes B and the exact
task-owned resources. Checkout deletion additionally fails while any container
still references the exact task path. Task names and destination paths must
not already exist.

## Non-Hermes exception

Ordinary local SnapReq development outside Hermes does not require Compose or
the `/opt/hermes-dind-shared` layout. It may use the native Node 24 workflow
(`npm ci`, then the npm checks) from a normal clone. This exception does not
apply to Hermes, Threadwire, task acceptance, or release/PR work performed for
a Hermes task.
