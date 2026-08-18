# ACCOMP-lish Threat Model

## Scope

This model covers the local dashboard, controller process, SQLite registry, controller-owned OMP RPC child processes, isolated Git worktrees, registered check runner, approval records, and browser event stream in Phases 0–3.

The control center is an orchestration and review surface. It is not a customer application, mail client, payment system, deployment platform, or autonomous self-modification system.

## Security invariants

1. The HTTP service binds only to `127.0.0.1` or `::1`; request host and remote address must also be loopback.
2. Browser mutations require a signed `HttpOnly`, `SameSite=Strict` session cookie, an exact CSRF token, and a loopback origin when an Origin header is present. Only SHA-256 hashes of session IDs and CSRF tokens are stored in SQLite; expiry cleanup runs at startup and on requests, so valid sessions survive a controller restart without persisting bearer values.
3. One dashboard agent maps to one registered agent ID and at most one controller-owned OMP process/session.
4. Every prompt, follow-up, abort, and host-tool result is sent to the exact bound OMP process. No process-global peer bus is used.
5. Model provider, model ID, reasoning level, and exposed host-tool names are selected by versioned policy and verified against OMP `get_state` before work is submitted.
6. Model output, OMP frames, browser-supplied check definitions, worktree content, filenames, and command output are untrusted.
7. Raw reasoning deltas, system prompts, credentials, full environments, unrestricted command output, direct owner mailbox addresses, and raw provider payloads are not persisted or streamed.
8. Model-backed OMP sessions receive no built-in tools, rules, skills, extensions, LSP, PTY, or session-file persistence. Only role-authorized controller host tools are exposed, and host-tool calls are accepted only during that exact session's active OMP turn.
9. Repository writes occur only in detached controller-owned Git worktrees, under active agent/goal/workspace territory leases. Workspace preparation binds the resolved base, narrow territory, and exact required-check definitions before OMP dispatch; Git hooks and filesystem monitors are disabled for controller Git operations, and a failed preparation releases the unused workspace. Symlink and traversal escapes fail closed.
10. Registered checks use a fixed executable allowlist, validated argument vectors, bounded output and time, a temporary HOME, no network, no candidate-worktree write permission, and file-read access limited to the candidate plus exact runtime dependencies. Controller state and owner files remain unreadable.
11. Quality and Security are distinct verifier identities and sessions. Gate evidence must name the exact current candidate, originate from the required verifier, and be independent from the producer role.
12. Any candidate identity change invalidates prior approvals. Any recorded Security failure blocks that candidate. Completion and final release evaluation independently recompute the workspace identity; release also requires evidence-gated completion, every exact required check, Quality pass, Security pass, and unexpired exact-artifact owner approval.
13. Restart never replays a prompt or action automatically. Previously active sessions become `disconnected`; their active goals become `blocked` pending a two-step owner retry action. An authorized retry starts a new bounded OMP attempt and first invalidates any attached candidate authority.
14. No host tool can send email, move money, make a legal commitment, push or merge Git, deploy, enable a provider, or operate on customer data.
15. The browser is never an authority store. Agent, goal, session, workspace, check, evidence, gate, and approval views are projections of controller state; every mutation is revalidated by the controller against current identity and status.
16. No generic goal-state, caller-supplied artifact identity, standalone check, evidence, gate, agent-authored approval request, or territory mutation endpoint exists. Those records originate only from atomic workspace preparation or the exact role-bound OMP host tool. Dedicated completion, retry, session cancellation, owner approval decision, and rollback paths enforce their lifecycle invariants. Completion revalidates exact evidence, checks, and on-disk identity and stops the producer session; final release evaluation recomputes identity again; rollback invalidates the candidate and approvals, releases leases, and quarantines the worktree.
17. Setup stores one non-secret OMP profile name. Every controller-owned OMP child receives that exact `--profile`; profile choice never substitutes for session authority.
18. External session authority comes only from a 48-byte full-control `/collab` bearer link. The raw link is validated in the browser, canonicalized to the official OMP web client, and never sent to the local API, SQLite, logs, or Web Storage. The browser retains only profile, room ID, relay origin, and a SHA-256 link fingerprint; a mismatched room, relay, key, or profile fails closed until explicit owner forget.
19. A project launcher derives identity from the canonical Git root and assigns one private capsule, stable port, runtime record, and controller instance nonce. A project-bound controller accepts workspaces only for that exact canonical repository. Start and stop operations verify live project, instance, process, and port identity; a mismatch fails closed.

## Assets

- Owner authority and exact approval decisions
- Agent and role identities
- Goal scope, acceptance criteria, and authority fields
- OMP session-to-agent mappings
- Worktree contents, base revisions, leases, diffs, and candidate identities
- Check and verifier evidence
- Approval request hashes and decisions
- Local session secret and OMP authentication material
- Sanitized event and message history
- Project registry, capsule identity, and per-project runtime records
- Versioned role contracts, model policy, check runs, and release-gate records

## Trust boundaries

### Trusted

- The human owner operating the local browser and terminal under the intended macOS account
- The reviewed controller code and its local SQLite database
- The exact OMP executable at `~/.local/bin/omp`
- Git and macOS `sandbox-exec` as installed by the host operating system
- Explicit owner approvals for the displayed immutable request and candidate

### Untrusted or adversarial

- Model-generated text and tool arguments
- Worktree files, repository history, symlinks, filenames, and test output
- Every RPC frame, including malformed JSON, partial or interleaved chunks, unmatched responses, unexpected event types, and provider-reported success
- Browser requests from non-loopback origins, DNS-rebinding attempts, forged Host headers, and stale CSRF tokens
- Crashed, stalled, or disconnected OMP processes
- A builder claiming its own checks passed
- A verifier attempting to approve work outside its independence contract
- A stale approval after candidate mutation

## Principal threats and controls

| Threat | Control | Failure behavior |
| --- | --- | --- |
| Cross-session prompt delivery | Exact `agentId → sessionId → child process` registry; no native process-global hub | Reject missing or mismatched session |
| Collaboration link disclosure | Password input, no API submission, no logging or Web Storage, `no-referrer` iframe, and URL-fragment delivery only to the official OMP client | Clear the in-memory link on disconnect or reload; the owner must stop `/collab` if disclosure is suspected |
| External session substitution | Persisted profile, room ID, relay origin, and full SHA-256 link fingerprint must all match; switching requires explicit disconnect and forget | Reject the new link without changing the remembered identity |
| View-only or malformed collaboration link | Exact current OMP link grammar, 48-byte full-control key requirement, secure WSS relay or loopback-only WS | Reject before constructing the embedded client URL |
| Model chooses a stronger/weaker route | Deterministic policy table and post-start `get_state` verification | Terminate initialization |
| Prompt injection requests unauthorized action | Static role/tool allowlists plus controller validation on every host call | Reject tool call; preserve bounded event |
| Hidden reasoning or secret leakage | Event allowlist, private-delta drop, sensitive-key redaction, assistant-output protected-material filter | Redacted marker or no event |
| RPC memory exhaustion or parser confusion | Controller configuration supplies the 1 MiB physical frame cap; the decoder enforces a 64 MiB logical cap, strict sequential chunk validation, and fatal UTF-8 decode | Terminate exact session as protocol failure |
| Workspace escape | Canonical roots, detached worktrees, traversal rejection, symlink resolution, lease checks | Reject operation |
| Cross-project state or repository access | Canonical Git-root project ID; separate database, secret, room binding, port, runtime record, and worktree root; exact repository enforcement during workspace creation | Reject capsule mismatch before creating a worktree or signaling a process |
| Concurrent edit conflict | Non-overlapping write leases tied to agent, goal, workspace, path, mode, and expiry | Reject conflicting lease |
| Check mutates candidate | Network-denied, worktree-read-only sandbox; only temporary HOME/TMP writes | Check fails; candidate remains unchanged |
| Unsafe or incomplete browser-defined check | Required-label equality, executable/argument validation, atomic workspace preparation, and read-only network-denied execution | Reject preparation or fail the exact run |
| Child-process output memory exhaustion | Check stdout and stderr each have a hard 200,000-byte capture cap; OMP stderr, public assistant output, persistent summaries, and event metadata have independent hard bounds | Kill or fail the exact process and retain only bounded sanitized evidence |
| Builder self-approval | Separate role IDs, sessions, evidence rows, and required independent verifier mapping | Gate record rejected |
| Stale approval reused | Request and candidate SHA-256 binding; mutation invalidation; expiry | Release blocked |
| Security failure hidden by later pass | Any failure for the exact candidate remains terminal | New candidate required |
| Controller or OMP crash | Durable state, explicit `crashed`/`disconnected` status, no automatic replay | Goal fails or blocks |
| Browser closed while work runs | Process lifecycle is controller-owned, not tab-owned | Work continues to next safe checkpoint unless explicitly interrupted |
| External side effect from dashboard | No external capability adapters in Phases 0–3 | Operation is unreachable |
| Generic terminal-state bypass | Dedicated completion and rollback endpoints; generic transitions reject `complete` and `rolled_back` | Reject mutation before state change |
| Stale or manipulated browser snapshot | Server-side mutation validation against current goal, request, workspace, and artifact state; browser stores no authority | Mutation rejected or current snapshot reloaded |
| Local registry loss or corruption | SQLite online backup, integrity and foreign-key verification, staged restore, exclusive-lock check, and preserved pre-restore database | Stop controller; restore only a verified owner-selected backup; never infer authority from workspace files |

## Residual risks and explicit limits

- **Same-account local process trust:** the current local session bootstrap is possession-based. A malicious process already running as the same macOS user can call the loopback endpoint and obtain its own local session. CSRF and loopback checks protect the browser boundary, not a compromised OS account. Do not run this controller on a shared or untrusted login session.
- **OMP authentication storage:** OMP receives the real user HOME so it can use existing provider authentication. The model receives no filesystem tool, but the OMP executable itself remains trusted code. A later stronger sandbox should isolate authentication without breaking the provider boundary.
- **Remote collaboration client trust:** paired-session content is end-to-end encrypted from the OMP host to the browser guest, and the relay is content-blind. Availability and delivery of the browser client still depend on `https://my.omp.sh`; compromise of that client origin could expose a link presented to it. Use only the reviewed official origin, stop `/collab` after suspected disclosure, and self-host the reviewed OMP web client if this supply-chain risk becomes unacceptable.
- **macOS-only check sandbox:** `sandbox-exec` behavior is verified on the supported macOS host. This project is not portable to another operating system without a separately reviewed sandbox implementation.
- **Single-controller assumption:** SQLite and in-memory session ownership assume one controller process for one data directory. Do not run two controller instances against the same database.
- **Shared core installation:** all projects execute the same reviewed ACCOMP-lish code and agent contracts. A compromised core installation can affect every capsule. Keep one reviewed installation, verify before upgrades, and do not point the global command at an untrusted clone.
- **No autonomous retention deletion yet:** sanitized operational state persists until the owner deletes the local data directory. Raw OMP transcript persistence is disabled. A retention worker must be separately authorized and tested before addition.
- **No production capability:** passing local gates does not authorize email, payments, legal commitments, remote pushes, hosted migrations, provider enablement, or deployment. Those adapters do not exist in this phase.
- **Model nondeterminism:** pinned provider/model/reasoning configuration reduces routing ambiguity but does not make output deterministic. Observable evidence and independent review remain mandatory.

## Phase authorization boundary

Each later phase requires a separate owner decision. Authorization must name the exact target directory, allowed external capabilities, maximum model/session budget, approval rules, and rollback. Completing this local dashboard does not authorize Phase 4 external adapters or any production action.
