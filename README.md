# ACCOMP-lish

A reusable, localhost-only OMP operations dashboard and project launcher. ACCOMP-lish supervises a bounded hierarchy of agents while keeping every project's identity, OMP room binding, goals, approvals, evidence, worktrees, audit history, and runtime process in a separate local capsule.

## What it provides

- A 36-role owner, orchestrator, director, specialist, and independent-verifier hierarchy
- One checked-in, role-specific command contract for every registered agent in `agents/`
- One exact OMP process per active agent session
- Live OMP lifecycle and message streaming over server-sent events
- Explicit idle, working, waiting, blocked, paused, stale, failed, and completed states
- Owner-authorized goals, repository scope, and external-effect declarations
- Controller-owned Git worktrees with narrow file-territory leases
- Independent Quality and Security evidence gates
- Artifact-bound approvals that are invalidated by candidate mutation
- Durable SQLite state, backup/restore, restart reconciliation, and explicit retry controls
- A default visual **Agent Cloud** plus an **Advanced operations** console
- A global `accomplish` command that selects the canonical Git project from any terminal session
- Concurrent project capsules with distinct ports, databases, secrets, logs, and controller identities

## Boundary

This is a private, single-owner macOS appliance, not a public SaaS service.

- HTTP binds only to `127.0.0.1` or `::1`.
- Browser mutations require a signed local session, an exact CSRF token, and a loopback origin.
- Repository-writing agents work only in controller-created, leased Git worktrees.
- A project-bound controller rejects workspace access to every repository except its capsule's canonical Git root.
- The control center does not push, merge, deploy, send email, make payments, or make legal commitments.
- OMP sessions receive only their checked-in command contract, bounded goal, allowed host tools, and sanitized context.
- Closing the browser does not stop controller-owned OMP processes; graceful server shutdown does.

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and [`docs/OPERATIONS.md`](docs/OPERATIONS.md) before operating it.

## Requirements

- macOS with `/usr/bin/sandbox-exec`
- Node.js 22 or newer
- Git
- OMP at `~/.local/bin/omp`
- OMP RPC protocol v2 and provider authentication in the local owner account

## Install once

```bash
npm ci
npm run verify
npm run build
npm run install:cli
```

`npm run install:cli` creates `~/.local/bin/accomplish` as a symlink to this reviewed installation. It refuses to replace a regular file, broken link, or link to another installation.

## Use from any project

Initialize one capsule from the target Git repository:

```bash
cd /path/to/project
accomplish init \
  --name "Example Project" \
  --owner "Alex Owner" \
  --omp-profile "default"
```

Then start or open only that project's dashboard:

```bash
accomplish up
accomplish open
accomplish status
accomplish stop
```

Prepare a task from any OMP or terminal session working in that repository:

```bash
accomplish "Improve scheduling" \
  --description "Preserve the existing workflow and tenant boundary." \
  --outcome "A verified candidate is ready for owner review."
```

The task command starts the matching project controller, opens its dashboard, and prepopulates a **New goal** draft. It never dispatches an agent automatically. Review the assigned agent, acceptance criteria, authority, required checks, and workspace before selecting **Dispatch goal**.

Run `accomplish projects` to list registered capsules. When calling from outside the repository, select one explicitly with `--project <16-character-project-id>`.

Each capsule lives outside every target repository at:

```text
~/Library/Application Support/ACCOMP-lish/
├── registry.json
└── projects/<project-id>/
    ├── organization.json
    ├── controller.log
    ├── runtime.json
    └── state/
```

The project ID is a stable digest of the canonical Git root. Each project receives a stable loopback port. Concurrent controllers cannot share a data directory or process identity, and lifecycle commands refuse to stop a process unless its health response matches the recorded project, instance, process, and port.

On each dashboard's first screen, open the exact terminal OMP session you intend to control and run `/collab`. Scan its QR code or paste only the full-control value printed after **or any web browser**. The link is a bearer secret: ACCOMP-lish gives it only to the official embedded OMP client and never sends it to the local API, database, logs, or browser storage. Each project capsule retains only its own non-secret room fingerprint.

## Configuration

`accomplish init` writes project identity and the selected OMP profile to the private capsule. Optional direct-runtime overrides use the `ACCOMPLISH_` namespace:

```bash
export ACCOMPLISH_ORGANIZATION_CONFIG=/absolute/path/to/organization.json
export ACCOMPLISH_ORGANIZATION_NAME="Example Organization"
export ACCOMPLISH_OWNER_NAME="Alex Owner"
export ACCOMPLISH_DATA_DIR=/absolute/private/path
export ACCOMPLISH_PORT=4317
```

Model routing can be pinned without editing source:

```bash
export ACCOMPLISH_OMP_PROVIDER=openai-codex
export ACCOMPLISH_MODEL_LUNA=gpt-5.6-luna
export ACCOMPLISH_MODEL_TERRA=gpt-5.6-terra
export ACCOMPLISH_MODEL_SOL=gpt-5.6-sol
```

The legacy standalone developer path remains available through `npm run setup` and `npm start`. Normal multi-project operation should use `accomplish init`, which binds workspace preparation to the selected canonical repository.

## Tailored agent commands

Every registered role has one contract at `agents/<AGENT-ID>.md`. Each file declares:

- exact `agent_id`, `role_id`, parent, and command-contract version
- hierarchy and reporting line
- mission and authority envelope
- allowed controller tools
- role-specific commands, inputs, outputs, required evidence, and escalation rules
- definition of done and explicit prohibitions

The controller validates all command files before initialization and again before loading an OMP session. Missing, oversized, symlinked, duplicate, stale-version, or identity-mismatched contracts fail closed.

Validate them directly:

```bash
npm run validate:agents
```

## Verification

```bash
npm run verify
```

The canonical gate runs agent-contract validation, TypeScript, Biome, behavioral tests, production builds, a high-severity dependency audit, and a pinned OMP RPC compatibility check. A provider-backed live smoke is available separately:

```bash
npm run smoke:live-omp
```

## Local state

Normal project state is stored under `~/Library/Application Support/ACCOMP-lish/projects/<project-id>/state/`. The standalone developer server uses `.data/`. Never point `ACCOMPLISH_DATA_DIR` inside this repository, a target repository, or another project's capsule.

Run database maintenance from this installation with the exact capsule state directory selected:

```bash
ACCOMPLISH_DATA_DIR=/absolute/capsule/state npm run db:backup
ACCOMPLISH_DATA_DIR=/absolute/capsule/state npm run db:verify
ACCOMPLISH_DATA_DIR=/absolute/capsule/state npm run db:restore -- /absolute/path/to/backup.sqlite3 --confirm-controller-stopped
```
