# Local Agent Control Center Operations

## Supported boundary

This runbook operates the localhost control center only. It does not send customer communications, access target-project data without an explicitly prepared workspace, move money, make legal commitments, push or merge code, deploy, or enable production providers.

Run commands from the cloned `omp-agent-control-center` repository. Target repositories remain separate and may be attached only through an owner-authorized isolated workspace.

The controller never stores its own state in a target repository.

## Owner quick start

1. Run `npm ci`.
2. Run `npm run setup` and enter the organization and human-owner display names. For non-interactive setup, run `npm run setup -- --organization "Organization Name" --owner "Owner Name"`.
3. Run `npm run verify`; the canonical gate includes the production build.
4. Start the controller with `NODE_ENV=production npm start`.
5. Open `http://127.0.0.1:4317/`. Confirm the header says **Live OMP stream** and the footer shows the expected controller, OMP, policy, and role-contract versions.
6. In **Command Center**, select the intended agent. Inspect its parent, mission, role authority, latest OMP lifecycle, workspace, territory, messages, checks, and evidence before assigning work.
7. Create one bounded draft in **New goal**. A repository-writing draft must name every required check, then use **Prepare isolated workspace** to bind the repository, narrow territory, exact local check commands, and one-hour lease atomically. Preparation does not start OMP or change the primary worktree.
8. Use **Dispatch goal** only after the exact agent, acceptance criteria, authority, and workspace are correct.
9. Keep **Approvals** for exact owner decisions. **Request changes** rejects the current request and requires a new exact candidate.
10. Use **Evidence & Releases** to confirm Quality, Security, checks, and owner approval all refer to one immutable candidate. **Gates recorded** means the ledger prerequisites pass; the controller still recomputes the full identity immediately before its final release decision. This controller cannot deploy.
11. Use **Interrupt** or **Cancel** on the exact selected session when required. Closing the browser does not stop controller-owned OMP processes. Accepting verified completion stops that goal's producer session.
12. For a `blocked`, `failed`, or `cancelled` goal, use the two-step **Authorize retry** control only after inspecting retained state. Retry starts a new bounded OMP attempt, renews an expired territory lease, and invalidates any attached candidate authority first. Use **Abandon attempt** instead to quarantine the workspace and release its lease.
13. Stop the controller with `Ctrl-C`; confirm shutdown before moving or deleting local state.

For one explicit provider-backed proof after installation, run `npm run smoke:live-omp`. It creates disposable state, accepts only the exact response `READY`, shuts down its OMP child, and removes the temporary registry.


## Prerequisites

- macOS with `/usr/bin/sandbox-exec`
- Node.js 22 or newer
- Git
- OMP at `~/.local/bin/omp`
- OMP RPC protocol v2 support; the current verified installation reports `omp/17.3.7`
- Existing OMP provider authentication in the owner account

Optional deterministic model overrides:

```bash
export OACC_OMP_PROVIDER=openai-codex
export OACC_MODEL_LUNA=gpt-5.6-luna
export OACC_MODEL_TERRA=gpt-5.6-terra
export OACC_MODEL_SOL=gpt-5.6-sol
```

The controller records the selected route and exact effective provider/model for every session. It fails initialization if OMP reports a different model, reasoning level, tool set, or session-file mode.

## Install and verify

From the control-center project:

```bash
npm ci
npm run verify
```

`npm run verify` performs TypeScript checks, Biome checks, behavioral tests, production builds, a high-severity dependency audit, and a harmless real OMP RPC compatibility probe. The RPC probe does not submit a model prompt.

To exercise one real model-backed session, exact provider/model verification, output streaming, and terminal lifecycle without tools or external effects:

```bash
npm run smoke:live-omp
```

This explicit smoke incurs one small provider call. It is intentionally excluded from `npm run verify`.

## Run

Development, with the API on `127.0.0.1:4317` and Vite on `127.0.0.1:4318`:

```bash
NODE_ENV=development npm run dev
```

Built local service:

```bash
npm run build
NODE_ENV=production npm start
```

Open `http://127.0.0.1:4318/` during development. Open `http://127.0.0.1:4317/` when running the built local service.

The service refuses non-loopback bind addresses, Host headers, and remote clients. Use one controller process per data directory.

## Local state

Default controller state:

```text
.data/control-center.sqlite3
.data/controller-secret
.data/omp/restricted.yml
.data/omp/cwd/
.data/workspaces/
.data/backups/
.data/tmp/
```

Permissions are created owner-only. `.data/`, build outputs, and coverage are Git-ignored.

To use a separate disposable state directory:

```bash
OACC_DATA_DIR=/absolute/private/path NODE_ENV=production npm start
```

Never point `OACC_DATA_DIR` inside the control-center repository, a target repository, or another customer-data repository.

## Backup and restore

Create a consistent SQLite backup while the controller is running or stopped:

```bash
npm run db:backup
```

The command uses SQLite's online backup API, runs integrity and foreign-key checks, writes an owner-only file under `.data/backups/`, and prints its exact path. Copy the whole `.data/` directory separately when detached workspaces must also be recoverable; the SQLite backup does not contain worktree files.

Verify either the live registry or one backup without changing it:

```bash
npm run db:verify
npm run db:verify -- /absolute/path/to/control-center-backup.sqlite3
```

Restore only after stopping the controller and confirming no controller process remains:

```bash
npm run db:restore -- /absolute/path/to/control-center-backup.sqlite3 --confirm-controller-stopped
```

Restore verifies the source, requires an exclusive target lock, stages and verifies a copy, preserves the previous database as `.pre-restore-<timestamp>`, removes old WAL/SHM companions from the live name, installs the replacement, and verifies it again. Keep the controller secret with the restored state so signed local sessions behave predictably. Restore the matching `.data/workspaces/` copy when continued candidate inspection is required. After restart, inspect disconnected sessions and blocked goals; no OMP action is replayed automatically.

## Dashboard workflow

### 1. Inspect before dispatch

Use **Command Center** and the agent detail panel to confirm:

- exact agent and role identity
- parent/director relationship
- role contract version
- current state and elapsed time
- model route
- current goal and workspace
- allowed tools and prohibited actions
- blockers, messages, checks, and recent evidence

### 2. Create a bounded goal

Use **New goal**. Supply:

- one registered non-human owner agent
- explicit title and description
- observable acceptance criteria
- exact required-check labels for executable work
- risk level and data class
- `Read-only` or `Isolated repository` write authority
- no external effects unless a later separately authorized adapter exists

A new goal remains `draft`. Creation never starts an OMP session.

For a draft with `isolated_repository` authority, the goal card first shows **Prepare isolated workspace**. Supply the canonical repository, immutable base ref, narrow relative territory, and one exact command for every required-check label. The controller resolves the base commit, creates a detached worktree, acquires the territory lease, and registers the checks as one preparation operation; any failed step rolls back the unused workspace. Preparation does not dispatch the goal. Recheck the workspace, lease, registered commands, and integration owner in Command Center, then use **Dispatch goal**.


### 3. Start explicitly

Use **Dispatch goal** only after reviewing the goal card. The controller:

1. creates one exact OMP child process for the assigned agent;
2. negotiates RPC v2;
3. installs only role-authorized host tools;
4. applies the versioned model policy;
5. verifies effective OMP state;
6. binds goal, agent, session, and optional workspace;
7. sends the bounded prompt.

A terminal model turn moves running work to `verifying`; it does not mark the goal complete.

The agent detail preserves historical session state after exit or restart, including requested/effective provider and model, route, terminal state, and sanitized failure summary. A missing live session is not displayed as idle.


### 4. Communicate safely

Free-form owner messages are allowed only to active read-only sessions. Write-capable sessions receive their scope through the immutable goal and controller host tools; the browser cannot steer them with arbitrary text.

Agent-to-agent messages are controller-mediated, exact-recipient, read-only, and goal-scoped. There is no native process-global hub in the controller architecture.

### 5. Interrupt or cancel

- **Interrupt** targets the selected streaming session and sends OMP `abort`. Other sessions continue.
- **Cancel** targets the selected session, aborts, closes stdin, waits for exact-process exit, and terminates only that process as a fallback. An active goal becomes `cancelled`.
- Closing the browser tab does not cancel work. The controller owns process lifecycle.

## State meanings

| State | Meaning | Operator action |
| --- | --- | --- |
| `Idle` | RPC ready; no queued goal or controller request | May receive a bounded read-only message or goal |
| `Queued` | Controller accepted the goal but has not submitted it | Inspect dispatch state |
| `Working` | OMP is streaming a turn | Observe; interrupt only if necessary |
| `Waiting for input` | OMP requested explicit input | Review the exact request; do not infer from silence |
| `Waiting for approval` | An unresolved exact approval blocks dispatch | Approve or reject in Approval Center |
| `Verifying` | Independent evidence is still required | Run/record required checks and verifier review |
| `Blocked` | Dependency, policy, conflict, or recoverable failure prevents progress | Resolve cause, then explicitly transition/restart |
| `Failed` | Terminal goal or process failure with retained evidence | Inspect error, quarantine candidate, create remediation goal |
| `Disconnected` | Controller restart or lost process; no replay occurred | Reconcile state and explicitly restart if still authorized |
| `Paused` | Controller intentionally stopped future work at a checkpoint | Resume only through a new explicit command |
| `Complete` | Acceptance evidence was accepted | Review final evidence; completion alone does not authorize release |

## Isolated repository work

Before creating a workspace, confirm the exact goal has `isolated_repository` authority and names the correct agent.

The controller creates a detached worktree at the exact base commit under `.data/workspaces/`. It records:

- repository root
- worktree path
- base and current revisions
- owner agent and goal
- read/write mode
- integration owner

Workspace preparation atomically acquires one narrow territory lease before dispatch. Overlapping write leases fail. Reads/writes reject traversal and symlink escapes. Controller tools do not push, merge, deploy, or edit the primary worktree.

A dirty workspace is quarantined rather than deleted. Review its exact status in the agent detail panel; do not bypass the quarantine by deleting registry rows.

Completed candidate workspaces are intentionally retained while exact release evidence may still be inspected and recomputed. They are not cascade-deleted when a parent goal settles. Director and verifier roles are read-only and therefore do not receive implementation workspaces. Use the explicit rollback/abandon path to release a lease and quarantine a candidate; remove retained workspaces only after preserving required evidence and confirming no exact release decision still depends on them.

## Checks, evidence, and completion

Every required check must be registered with its exact label and command while the isolated workspace is prepared. The controller rejects missing, extra, or duplicate labels. Allowed executables are bounded to the local verification set; URLs and publish/deploy/push arguments are rejected. Each run records:

- exact agent, goal, workspace, and check ID
- executable, argument vector, and relative working directory
- candidate SHA-256 identity
- result and exit code
- sanitized output summary
- timestamps

The check sandbox can read the candidate but cannot write it or access the network. A check process that tries to mutate the worktree fails.

An implementation agent submits the current worktree through **Submit candidate**; the controller computes and attaches the immutable identity. Goal completion through **Accept verified completion** recomputes that identity and requires independent evidence plus a passing current-candidate run for every named required-check label. Final release evaluation recomputes it again; any out-of-band change invalidates the candidate, passing gates, and owner approval. An agent statement that work is complete is not evidence.

The **Evidence & Releases** view projects the durable evidence, exact check commands and runs, approval, and release-gate registries. It shows limitations and a separate state for every exact-candidate gate; it does not infer readiness from goal status or agent output.


## Approval and release gate

Approval Center shows the exact action, target, agent, goal, artifact hash, risk, request hash, and expiry.

Only `OWNER-01` can approve or reject. Approval is append-only and exact-request scoped.

The requesting agent must own the bounded goal, and the request risk must exactly match the goal risk. Pending and approved requests both expire at their recorded deadline; expiration records `approval.expired` and removes release authority immediately.


Release readiness requires all of:
1. current goal artifact identity equals the evaluated artifact;
2. the goal is complete through the evidence-gated completion endpoint;
3. every named required check has a passing run for that exact candidate;
4. no Security failure exists for that candidate;
5. latest independent Security result is `pass`;
6. latest independent Quality result is `pass`;
7. an unexpired owner approval for `release` or `deployment` names that exact artifact.

Any candidate mutation invalidates prior approvals. A Security failure requires a new candidate; a later pass does not erase the failure.

The local ledger can show that all prerequisites were recorded, but a final controller evaluation must recompute the exact candidate before returning readiness. No deployment capability exists.

**Request changes** is an explicit rejection of the current request with a durable decision note. The producer must submit a new exact request; the dashboard does not mutate or silently reopen the rejected approval.

**Withdraw candidate** and **Abandon attempt** are two-step local rollback controls. Confirmation stops the bound OMP session when present, releases its territory lease, quarantines the detached worktree for inspection, invalidates any candidate identity and matching approvals, records `rollback.started` and `rollback.completed`, and settles the goal as `rolled_back`. Evidence is preserved, including when no candidate was submitted. Neither action edits the primary worktree; replacement work requires a new bounded goal and workspace unless the owner chooses the separate retry path before rollback.


## Continuous improvement records

The **Improve** view accepts only a bounded owner-authored hypothesis tied to retained operational events. Move a record through sandbox, independent evaluation, canary, observation, adoption, rejection, or rollback only when the stage note states observable evidence and limitations.

**Export review record** downloads a versioned JSON record containing the complete proposal, current state, full artifact identity, controller version, and role-contract version. Review that record before translating an adopted proposal into a normal code, configuration, role-contract, or runbook change. Adoption in this ledger never edits files, prompts, tools, permissions, or production state; promotion still requires the ordinary reviewed change and verification process.

## Restart and recovery

On controller startup, durable reconciliation runs before new work:

- `configured`, `starting`, `ready`, `streaming`, `idle`, and `stopping` sessions become `disconnected`;
- associated active goals become `blocked`;
- agents show explicit restart-required status;
- no prompt, tool call, approval, or external action is replayed.
- signed owner sessions and CSRF hashes remain in SQLite until expiry or logout, so a controller restart does not force an otherwise valid local browser session to reauthenticate;

A streaming session that emits no OMP frame within the configured threshold is shown as **Unresponsive** and records one `session.stale` warning. The controller does not guess that silence means failure or replay work. The next frame records `session.responsive` and clears the warning; the owner may interrupt or cancel the exact session.


Recovery procedure:

1. Keep external capabilities disabled.
2. Inspect the disconnected session, last accepted event, goal, worktree, check runs, candidate identity, and territory lease.
3. Confirm the old OMP process is not still running.
4. To continue the same bounded goal, select **Authorize retry**, then **Confirm new OMP attempt**. This is the explicit replay boundary: the controller queues and submits a new prompt only after that owner action. Any prior candidate identity, passing gates, and approval authority are invalidated first; an expired lease is renewed against the original territory.
5. To stop, select **Abandon attempt**, then confirm. The controller stops any bound session, releases the lease, quarantines the detached worktree, preserves evidence, and settles the goal as `rolled_back` even when no candidate was submitted.
6. If the original workspace is missing, released, or quarantined, create a new bounded goal and workspace instead of retrying.
7. Re-run all affected checks and independent gates.

If the SQLite database fails an integrity check, stop the controller, preserve the database and workspaces, run `npm run db:verify -- <backup>`, and restore only a verified matching backup with the procedure above. Never infer approval from files outside the registry.

## Incident containment

### Protocol error, malformed frame, or partial chunk

- Exact session terminates as a protocol failure.
- Its goal fails or blocks with sanitized evidence.
- Other sessions remain active.
- Do not retry automatically. Verify OMP version and reproduce with the harmless RPC probe.

### OMP crash or stale stream

- Inspect `session.crashed`, exit code, and sanitized stderr.
- A stale event is an alert, not automatic cancellation.
- Interrupt or cancel the exact session if required.
- Do not relabel silence as idle.

### Secret or protected-output alert

- Stop the selected session.
- Preserve only the redacted event and candidate identity.
- Revoke exposed credentials outside the controller if exposure cannot be ruled out.
- Do not paste raw prompts, reasoning, environment data, or provider payloads into the dashboard or issue tracker.

### Dirty or escaped workspace attempt

- Keep the workspace quarantined.
- Revoke its leases and stop its agent session.
- Compare the primary repository status with the recorded base; the primary tree should remain unchanged.
- Delete only after evidence and any required remediation are preserved.

## Shutdown

Use `Ctrl-C` in the controller terminal. Graceful shutdown aborts active sessions, closes their input, waits for exit, and uses process-specific termination only as a fallback.

After shutdown, verify no controller process remains before moving or deleting `.data/`. Browser closure alone is not shutdown.

## Destructive local reset

Only when no evidence or workspace must be retained:

```bash
rm -rf .data dist-web dist-server coverage
```

This deletes the local registry, approvals, session history, controller secret, and worktrees. It does not modify a target repository, but it permanently removes local audit evidence. Preserve required evidence first.
