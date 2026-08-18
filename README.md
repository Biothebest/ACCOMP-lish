# OMP Agent Control Center

A reusable, localhost-only operations dashboard for supervising a bounded hierarchy of OMP agents. The browser shows live agent state, assignments, handoffs, approvals, evidence, isolated workspaces, and recovery controls without exposing raw terminal sessions.

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

## Boundary

This is a private, single-owner macOS appliance, not a public SaaS service.

- HTTP binds only to `127.0.0.1` or `::1`.
- Browser mutations require a signed local session, an exact CSRF token, and a loopback origin.
- Repository-writing agents work only in controller-created, leased Git worktrees.
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

## Fresh setup

```bash
npm ci
npm run setup
npm run verify
NODE_ENV=production npm start
```

Open <http://127.0.0.1:4317/>.

Interactive setup asks for the organization, human-owner display name, and existing OMP profile. Non-interactive setup:

```bash
npm run setup -- \
  --organization "Example Organization" \
  --owner "Alex Owner" \
  --omp-profile "default"
```

Setup writes the Git-ignored `config/organization.json` from the checked-in schema example. Runtime fails closed when that file is absent, malformed, or names an invalid profile.

On the dashboard's first screen, open the exact terminal OMP session you intend to control and run `/collab`. Scan its QR code or paste only the full-control value printed after **or any web browser**; OMP displays that copyable value as `my.omp.sh/#…`, without a visible `https://` prefix. The link is a bearer secret: the control center gives it only to the official embedded OMP client and never sends it to the local API, database, logs, or browser storage. Only a non-secret room fingerprint is retained; reloads require the same link, and another room is rejected until the owner explicitly forgets the binding.

## Project customization

`config/organization.json` controls display identity and the OMP configuration scope used by controller-owned sessions:

```json
{
  "schemaVersion": 2,
  "organizationName": "Example Organization",
  "ownerDisplayName": "Alex Owner",
  "ompProfile": "default"
}
```

Optional environment overrides:

```bash
export OACC_ORGANIZATION_CONFIG=/absolute/path/to/organization.json
export OACC_ORGANIZATION_NAME="Example Organization"
export OACC_OWNER_NAME="Alex Owner"
export OACC_DATA_DIR=/absolute/private/path
export OACC_PORT=4317
```

Model routing can be pinned without editing source:

```bash
export OACC_OMP_PROVIDER=openai-codex
export OACC_MODEL_LUNA=gpt-5.6-luna
export OACC_MODEL_TERRA=gpt-5.6-terra
export OACC_MODEL_SOL=gpt-5.6-sol
```

A target repository is selected only when the owner prepares an isolated workspace for an authorized goal. The target repository remains separate from this control-center repository and from `.data/`.

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

Operational state is stored under `.data/` by default and is excluded from Git. Never place `OACC_DATA_DIR` inside this repository or a target repository.

```bash
npm run db:backup
npm run db:verify
npm run db:restore -- /absolute/path/to/backup.sqlite3 RESTORE
```
