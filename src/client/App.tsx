import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentDetail,
  AgentNode,
  AgentState,
  AgentSummary,
  ApprovalSummary,
  CheckDefinitionSummary,
  CheckRunSummary,
  DashboardSnapshot,
  EventSummary,
  EvidenceSummary,
  GoalSummary,
  ImprovementReviewSummary,
  ImprovementState,
  ReleaseGateSummary,
} from "../shared/contracts.js";
import { type AccomplishGoalPrefill, consumeAccomplishGoalPrefill } from "./accomplish.js";
import {
  type CreateGoalRequest,
  type CreateImprovementRequest,
  DashboardApi,
  DashboardApiError,
  type WorkspaceCheckInput,
} from "./api.js";
import { CloudExperience } from "./CloudExperience.js";
import { PairedSession, PairingOnboarding } from "./PairingExperience.js";
import {
  establishPairing,
  PAIRING_IDENTITY_STORAGE_KEY,
  type PairingConnection,
  type PairingIdentity,
  parseStoredPairingIdentity,
  serializePairingIdentity,
} from "./pairing.js";

type View = "session" | "cloud" | "command" | "goals" | "approvals" | "evidence" | "improvement";
type IconName =
  | "command"
  | "goals"
  | "approval"
  | "evidence"
  | "improve"
  | "agent"
  | "pulse"
  | "clock"
  | "shield"
  | "chevron"
  | "send"
  | "stop"
  | "play"
  | "refresh"
  | "close"
  | "plus"
  | "search"
  | "link";
const api = new DashboardApi();
const APPROVAL_PAGE_SIZE = 8;

function loadStoredPairingIdentity(): PairingIdentity | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(PAIRING_IDENTITY_STORAGE_KEY);
    const identity = parseStoredPairingIdentity(stored);
    if (stored && !identity) window.localStorage.removeItem(PAIRING_IDENTITY_STORAGE_KEY);
    return identity;
  } catch {
    return null;
  }
}

const STATUS_LABELS: Readonly<Record<AgentState, string>> = {
  idle: "Idle",
  queued: "Queued",
  running: "Working",
  waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval",
  verifying: "Verifying",
  blocked: "Blocked",
  failed: "Failed",
  complete: "Complete",
  disconnected: "Disconnected",
  paused: "Paused",
  cancelled: "Cancelled",
};

const NAV_ITEMS: ReadonlyArray<{ id: View; label: string; icon: IconName }> = [
  { id: "session", label: "Paired OMP Session", icon: "link" },
  { id: "cloud", label: "Agent Cloud", icon: "agent" },
  { id: "command", label: "Command Center", icon: "command" },
  { id: "goals", label: "Goal Board", icon: "goals" },
  { id: "approvals", label: "Approvals", icon: "approval" },
  { id: "evidence", label: "Evidence & Releases", icon: "evidence" },
  { id: "improvement", label: "Continuous Improvement", icon: "improve" },
];

export default function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("ORCH-01");
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [view, setView] = useState<View>("session");
  const [cloudAgentId, setCloudAgentId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [goalPrefill, setGoalPrefill] = useState<AccomplishGoalPrefill | null>(consumeAccomplishGoalPrefill);
  const [goalModalOpen, setGoalModalOpen] = useState(goalPrefill !== null);
  const [workspaceGoal, setWorkspaceGoal] = useState<GoalSummary | null>(null);
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const refreshTimer = useRef<NodeJS.Timeout | null>(null);
  const [pairingIdentity, setPairingIdentity] = useState<PairingIdentity | null>(loadStoredPairingIdentity);
  const [pairingConnection, setPairingConnection] = useState<PairingConnection | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await api.snapshot(signal);
    setSnapshot(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe: () => void = () => {};
    void (async () => {
      try {
        await api.connect();
        await refresh(controller.signal);
        unsubscribe = api.subscribe((event) => {
          if (event.kind === "activity" && event.activity) {
            setLiveText((current) => ({
              ...current,
              [event.activity?.sessionId ?? "unknown"]:
                `${current[event.activity?.sessionId ?? "unknown"] ?? ""}${event.activity?.text ?? ""}`.slice(
                  -20_000,
                ),
            }));
            return;
          }
          if (refreshTimer.current) {
            clearTimeout(refreshTimer.current);
          }
          refreshTimer.current = setTimeout(() => {
            void refresh().catch((refreshError) => setError(errorMessage(refreshError)));
          }, 120);
        }, setConnected);
      } catch (connectError) {
        setError(errorMessage(connectError));
        setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      unsubscribe();
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
      }
    };
  }, [refresh]);

  useEffect(() => {
    if (!snapshot?.agents.some((agent) => agent.agentId === selectedAgentId)) {
      return;
    }
    const controller = new AbortController();
    void api
      .agentDetail(selectedAgentId, controller.signal)
      .then(setAgentDetail)
      .catch((detailError) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(detailError));
        }
      });
    return () => controller.abort();
  }, [selectedAgentId, snapshot]);

  const act = useCallback(
    async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await operation();
        setNotice(success);
        await refresh();
        if (selectedAgentId) {
          setAgentDetail(await api.agentDetail(selectedAgentId));
        }
        return true;
      } catch (operationError) {
        setError(errorMessage(operationError));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, selectedAgentId],
  );

  const configuredOmpProfile = snapshot?.controller.ompProfile ?? null;
  const pairSession = useCallback(
    async (link: string) => {
      if (!configuredOmpProfile) throw new Error("Controller OMP profile is unavailable.");
      const connection = await establishPairing(link, configuredOmpProfile, pairingIdentity);
      try {
        window.localStorage.setItem(
          PAIRING_IDENTITY_STORAGE_KEY,
          serializePairingIdentity(connection.identity),
        );
      } catch {
        throw new Error("The browser could not retain the non-secret room binding. Pairing was not started.");
      }
      setPairingIdentity(connection.identity);
      setPairingConnection(connection);
      setView("session");
    },
    [configuredOmpProfile, pairingIdentity],
  );

  const forgetPairing = useCallback(() => {
    try {
      window.localStorage.removeItem(PAIRING_IDENTITY_STORAGE_KEY);
    } catch {
      return;
    }
    setPairingConnection(null);
    setPairingIdentity(null);
  }, []);

  const selectedAgent = snapshot?.agents.find((agent) => agent.agentId === selectedAgentId) ?? null;
  const pendingApprovals = snapshot?.approvals.filter((approval) => approval.status === "pending") ?? [];
  const cloudMode = view === "cloud";
  const sessionMode = view === "session";
  const cloudAgent = cloudAgentId
    ? (snapshot?.agents.find((agent) => agent.agentId === cloudAgentId) ?? null)
    : null;

  if (loading) {
    return <LoadingScreen />;
  }

  if (snapshot && !pairingConnection) {
    return (
      <PairingOnboarding
        organizationName={snapshot.controller.organizationName}
        ownerDisplayName={snapshot.controller.ownerDisplayName}
        ompProfile={snapshot.controller.ompProfile}
        controllerConnected={connected}
        expectedIdentity={pairingIdentity}
        onPair={pairSession}
        onForget={forgetPairing}
      />
    );
  }

  return (
    <div className={`app-shell ${cloudMode ? "cloud-mode" : ""} ${sessionMode ? "session-mode" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span>A</span>
          </div>
          <div>
            <p className="eyebrow">{snapshot?.controller.organizationName ?? "OMP"}</p>
            <h1>{cloudMode ? "Agent Cloud" : "ACCOMP-lish"}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          {cloudMode ? (
            <button className="cloud-advanced-button" type="button" onClick={() => setView("command")}>
              <Icon name="command" />
              Advanced operations
            </button>
          ) : null}
          <div className={`connection-pill ${connected ? "online" : "offline"}`}>
            <span className="connection-dot" />
            {connected ? "Controller live" : "Controller reconnecting"}
          </div>
          <span className="separator" />
          <div className="owner-chip">
            <span className="owner-avatar">{initials(snapshot?.controller.ownerDisplayName ?? "Owner")}</span>
            <div>
              <strong>{snapshot?.controller.ownerDisplayName ?? "Owner"}</strong>
              <small>Human authority</small>
            </div>
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <nav aria-label="Primary navigation">
          <p className="nav-heading">Views</p>
          {NAV_ITEMS.map((item) => (
            <button
              className={`nav-item ${view === item.id ? "active" : ""}`}
              key={item.id}
              onClick={() => setView(item.id)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === "approvals" && pendingApprovals.length > 0 ? (
                <b>{pendingApprovals.length}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="safety-card">
            <Icon name="shield" />
            <div>
              <strong>Local safety mode</strong>
              <span>Loopback only · No production adapters</span>
            </div>
          </div>
          <span className="version">
            Controller {snapshot?.controller.version ?? "—"} · OMP{" "}
            {snapshot?.controller.ompVersion ?? "unavailable"}
          </span>
          <span className="version">OMP profile {snapshot?.controller.ompProfile ?? "—"}</span>
          <span className="version">
            Policy {snapshot?.controller.policyVersion ?? "—"} · Roles{" "}
            {snapshot?.controller.roleContractVersion ?? "—"}
          </span>
        </div>
      </aside>

      <main className="main-stage">
        {pairingConnection ? (
          <div
            className={sessionMode ? "paired-session-active" : "paired-session-hidden"}
            aria-hidden={!sessionMode}
          >
            <PairedSession connection={pairingConnection} onDisconnect={() => setPairingConnection(null)} />
          </div>
        ) : null}
        {cloudMode && snapshot ? (
          <CloudExperience
            snapshot={snapshot}
            selectedAgent={cloudAgent}
            detail={cloudAgent?.agentId === agentDetail?.agent.agentId ? agentDetail : null}
            connected={connected}
            onSelect={(agentId) => {
              setSelectedAgentId(agentId);
              setCloudAgentId(agentId);
            }}
            onClose={() => setCloudAgentId(null)}
            onNewGoal={() => {
              setGoalPrefill(null);
              setGoalModalOpen(true);
            }}
            onAdvanced={() => {
              if (cloudAgentId) setSelectedAgentId(cloudAgentId);
              setView("command");
            }}
          />
        ) : null}
        <section className="stage-heading">
          <div>
            <p className="eyebrow">{NAV_ITEMS.find((item) => item.id === view)?.label}</p>
            <h2>{viewTitle(view)}</h2>
            <p>{viewDescription(view)}</p>
          </div>
          <div className="heading-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={() => void refresh().catch((refreshError) => setError(errorMessage(refreshError)))}
            >
              <Icon name="refresh" /> Refresh
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setGoalPrefill(null);
                setGoalModalOpen(true);
              }}
            >
              <Icon name="plus" /> New goal
            </button>
          </div>
        </section>

        {error ? <Toast tone="error" message={error} onClose={() => setError(null)} /> : null}
        {notice ? <Toast tone="success" message={notice} onClose={() => setNotice(null)} /> : null}

        <KpiStrip snapshot={snapshot} />

        {view === "command" ? (
          <CommandCenter
            snapshot={snapshot}
            selectedAgent={selectedAgent}
            detail={agentDetail}
            liveText={selectedAgent?.sessionId ? (liveText[selectedAgent.sessionId] ?? "") : ""}
            busy={busy}
            message={message}
            onMessageChange={setMessage}
            onSelect={setSelectedAgentId}
            onStart={() => {
              if (selectedAgent) {
                void act(
                  () => api.startAgent(selectedAgent.agentId),
                  `${selectedAgent.displayName} session started`,
                );
              }
            }}
            onSend={() => {
              if (selectedAgent && message.trim()) {
                const outgoing = message.trim();
                setMessage("");
                void act(
                  () => api.sendMessage(selectedAgent.agentId, outgoing),
                  "Message delivered to the exact OMP session",
                );
              }
            }}
            onInterrupt={() => {
              if (selectedAgent?.sessionId) {
                void act(
                  () => api.interruptSession(selectedAgent.sessionId as string),
                  "Selected session interrupted",
                );
              }
            }}
            onCancel={() => {
              if (selectedAgent?.sessionId) {
                void act(
                  () => api.cancelSession(selectedAgent.sessionId as string),
                  "Selected session cancelled",
                );
              }
            }}
          />
        ) : null}
        {view === "goals" ? (
          <GoalBoard
            snapshot={snapshot}
            busy={busy}
            onPrepare={setWorkspaceGoal}
            onStart={(goalId) =>
              void act(() => api.startGoal(goalId), "Goal dispatched to its exact OMP session")
            }
            onRetry={(goalId) =>
              void act(
                () =>
                  api.retryGoal(
                    goalId,
                    "Human owner explicitly authorized a new OMP attempt from the current local workspace.",
                  ),
                "Explicit goal retry dispatched to a new OMP session",
              )
            }
            onComplete={(goalId) =>
              void act(() => api.completeGoal(goalId), "Verified goal accepted and settled")
            }
            onRollback={(goalId) =>
              void act(
                () =>
                  api.rollbackGoal(
                    goalId,
                    "Owner withdrew the bounded local attempt; preserve evidence and require a new authorized attempt.",
                  ),
                "Attempt withdrawn; workspace quarantined and prior authority invalidated",
              )
            }
          />
        ) : null}
        {view === "approvals" ? (
          <ApprovalCenter
            approvals={snapshot?.approvals ?? []}
            agents={snapshot?.agents ?? []}
            goals={snapshot?.goals ?? []}
            busy={busy}
            onDecision={(approval, decision, note) =>
              void act(
                () => api.decideApproval(approval.approvalId, decision, note),
                decision === "approved" ? "Exact request approved" : "Exact request rejected",
              )
            }
          />
        ) : null}
        {view === "evidence" ? (
          <EvidenceCenter
            evidence={snapshot?.evidence ?? []}
            goals={snapshot?.goals ?? []}
            approvals={snapshot?.approvals ?? []}
            checkDefinitions={snapshot?.checkDefinitions ?? []}
            checkRuns={snapshot?.checkRuns ?? []}
            releaseGates={snapshot?.releaseGates ?? []}
          />
        ) : null}
        {view === "improvement" ? (
          <ImprovementCenter
            events={snapshot?.events ?? []}
            improvements={snapshot?.improvements ?? []}
            busy={busy}
            onCreate={(input) => act(() => api.createImprovement(input), "Improvement review proposed")}
            onTransition={(reviewId, state, resultSummary, limitations) =>
              act(
                () => api.transitionImprovement(reviewId, state, resultSummary, limitations),
                `Improvement review moved to ${state}`,
              )
            }
          />
        ) : null}
      </main>

      <aside className="activity-rail">
        <div className="rail-heading">
          <div>
            <p className="eyebrow">Live record</p>
            <h3>Activity</h3>
          </div>
          <Icon name="pulse" />
        </div>
        <ActivityFeed
          events={snapshot?.events ?? []}
          agents={snapshot?.agents ?? []}
          onSelectAgent={(agentId) => {
            setSelectedAgentId(agentId);
            setView("command");
          }}
        />
      </aside>

      {goalModalOpen && snapshot ? (
        <GoalModal
          agents={snapshot.agents}
          busy={busy}
          initialInput={goalPrefill}
          onClose={() => {
            setGoalPrefill(null);
            setGoalModalOpen(false);
          }}
          onSubmit={(input) => {
            void act(() => api.createGoal(input), "Goal created and held in draft until dispatch").then(
              (succeeded) => {
                if (succeeded) {
                  setGoalPrefill(null);
                  setGoalModalOpen(false);
                }
              },
            );
          }}
        />
      ) : null}
      {workspaceGoal ? (
        <WorkspaceModal
          goal={workspaceGoal}
          busy={busy}
          onClose={() => setWorkspaceGoal(null)}
          onSubmit={(repositoryPath, baseRef, territoryPath, checks) => {
            void act(
              () =>
                api.createWorkspace(
                  workspaceGoal.goalId,
                  repositoryPath,
                  baseRef,
                  "write",
                  territoryPath,
                  checks,
                ),
              "Isolated workspace, territory, and exact checks prepared",
            ).then((succeeded) => {
              if (succeeded) setWorkspaceGoal(null);
            });
          }}
        />
      ) : null}
    </div>
  );
}

function KpiStrip({ snapshot }: { snapshot: DashboardSnapshot | null }): ReactNode {
  const items = [
    {
      label: "Active agents",
      value: snapshot?.counts.activeAgents ?? 0,
      detail: `${snapshot?.agents.length ?? 0} registered`,
      icon: "agent" as const,
      tone: "blue",
    },
    {
      label: "Running goals",
      value: snapshot?.counts.runningGoals ?? 0,
      detail: `${snapshot?.goals.length ?? 0} total goals`,
      icon: "pulse" as const,
      tone: "cyan",
    },
    {
      label: "Awaiting approval",
      value: snapshot?.counts.waitingApprovals ?? 0,
      detail: "Exact owner decisions",
      icon: "approval" as const,
      tone: "gold",
    },
    {
      label: "Blocked items",
      value: snapshot?.counts.blockedItems ?? 0,
      detail: "Require intervention",
      icon: "shield" as const,
      tone: "red",
    },
  ];
  return (
    <section className="kpi-strip">
      {items.map((item) => (
        <article className="kpi-card" key={item.label}>
          <span className={`kpi-icon ${item.tone}`}>
            <Icon name={item.icon} />
          </span>
          <div>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
            <span>{item.detail}</span>
          </div>
        </article>
      ))}
    </section>
  );
}

interface CommandCenterProps {
  snapshot: DashboardSnapshot | null;
  selectedAgent: AgentSummary | null;
  detail: AgentDetail | null;
  liveText: string;
  busy: boolean;
  message: string;
  onMessageChange(value: string): void;
  onSelect(agentId: string): void;
  onStart(): void;
  onSend(): void;
  onInterrupt(): void;
  onCancel(): void;
}

function CommandCenter(props: CommandCenterProps): ReactNode {
  const parentAgent = props.snapshot?.agents.find(
    (agent) => agent.agentId === props.selectedAgent?.parentAgentId,
  );
  const childAgents =
    props.snapshot?.agents.filter((agent) => agent.parentAgentId === props.selectedAgent?.agentId) ?? [];
  const latestSession = props.detail?.sessions[0] ?? null;
  const latestSessionEvent = props.snapshot?.events.find(
    (event) => event.sessionId === props.selectedAgent?.sessionId,
  );
  const sessionIsStale = latestSessionEvent?.type === "session.stale";
  return (
    <section className="command-grid">
      <article className="panel hierarchy-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Organization</p>
            <h3>Agent hierarchy</h3>
          </div>
          <span>{props.snapshot?.agents.length ?? 0}</span>
        </div>
        <div className="hierarchy-list">
          {(props.snapshot?.hierarchy ?? []).map((node) => (
            <HierarchyNode
              key={node.agentId}
              node={node}
              selectedId={props.selectedAgent?.agentId ?? ""}
              depth={0}
              onSelect={props.onSelect}
            />
          ))}
        </div>
      </article>

      <article className="panel agent-panel">
        {props.selectedAgent && props.detail ? (
          <>
            <div className="agent-hero">
              <div className="agent-identity">
                <span className={`agent-avatar ${props.selectedAgent.kind}`}>
                  {initials(props.selectedAgent.displayName)}
                </span>
                <div>
                  <p className="eyebrow">{props.selectedAgent.agentId}</p>
                  <h3>{props.selectedAgent.displayName}</h3>
                  <span>{props.selectedAgent.roleName}</span>
                </div>
              </div>
              <StatusBadge state={props.selectedAgent.state} stale={sessionIsStale} />
            </div>
            <div className="agent-metadata">
              <MetadataItem label="Model" value={props.selectedAgent.model ?? "Policy selected on start"} />
              <MetadataItem label="Reasoning" value={props.selectedAgent.reasoning ?? "—"} />
              <MetadataItem
                label={props.selectedAgent.sessionId ? "Session" : "Last session"}
                value={
                  props.selectedAgent.sessionId
                    ? shortId(props.selectedAgent.sessionId)
                    : latestSession
                      ? shortId(latestSession.sessionId)
                      : "Not started"
                }
              />
              <MetadataItem label="Heartbeat" value={relativeTime(props.selectedAgent.lastHeartbeatAt)} />
              <MetadataItem label="Parent" value={parentAgent?.displayName ?? "Human authority"} />
              <MetadataItem
                label="Workspace"
                value={props.detail.workspace ? shortId(props.detail.workspace.workspaceId) : "None assigned"}
              />
            </div>
            <div className="contract-callout">
              <Icon name="shield" />
              <div>
                <strong>Mission</strong>
                <p>{props.detail.role.mission}</p>
              </div>
            </div>
            <div className="section-block">
              <details className="contract-details">
                <summary>
                  Inspect role authority
                  <code>contract {props.snapshot?.controller.roleContractVersion ?? "—"}</code>
                </summary>
                <div className="contract-grid">
                  <div>
                    <small>Allowed host tools</small>
                    <div className="tag-row">
                      {props.detail.role.allowedTools.length > 0 ? (
                        props.detail.role.allowedTools.map((tool) => <span key={tool}>{tool}</span>)
                      ) : (
                        <span>none</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <small>Reporting and permissions</small>
                    <ul>
                      <li>Reports to {props.detail.role.reportsToRoleId ?? "none"}</li>
                      <li>Data: {props.detail.role.dataAccess.join(", ")}</li>
                      <li>Write scope: {props.detail.role.writeScope}</li>
                      <li>May delegate: {props.detail.role.mayDelegate ? "yes" : "no"}</li>
                      <li>
                        May approve:{" "}
                        {props.detail.role.mayApprove.length > 0
                          ? props.detail.role.mayApprove.join(", ")
                          : "none"}
                      </li>
                    </ul>
                  </div>
                  {[
                    ["Owns", props.detail.role.owns],
                    ["Inputs", props.detail.role.inputs],
                    ["Outputs", props.detail.role.outputs],
                    ["May delegate to", props.detail.role.mayDelegateTo],
                    ["May write to", props.detail.role.mayWriteTo],
                    ["Approval required", props.detail.role.approvalRequired],
                    ["Evaluation suite", props.detail.role.evaluationSuite],
                    ["Handoff contract", props.detail.role.handoffRequirements],
                  ].map(([label, values]) => (
                    <div key={label as string}>
                      <small>{label}</small>
                      <ul>
                        {(values as readonly string[]).length > 0 ? (
                          (values as readonly string[]).map((item) => <li key={item}>{item}</li>)
                        ) : (
                          <li>none</li>
                        )}
                      </ul>
                    </div>
                  ))}
                  <div>
                    <small>Prohibited actions</small>
                    <ul>
                      {props.detail.role.prohibited.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <small>Definition of done</small>
                    <ul>
                      {props.detail.role.definitionOfDone.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <small>Escalate when</small>
                    <ul>
                      {props.detail.role.escalationConditions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </details>
            </div>
            <div className="section-block">
              <div className="section-title">
                <h4>Current assignment</h4>
                {props.detail.goal ? <StatePill value={props.detail.goal.state} /> : null}
              </div>
              {props.detail.goal ? (
                <div className="goal-focus">
                  <strong>{props.detail.goal.title}</strong>
                  <p>{props.detail.goal.description}</p>
                  <div className="tag-row">
                    <span>{props.detail.goal.riskLevel} risk</span>
                    <span>{props.detail.goal.writeScope.replaceAll("_", " ")}</span>
                    <span>{props.detail.goal.acceptanceCriteria.length} acceptance checks</span>
                  </div>
                  <ol className="criteria-list">
                    {props.detail.goal.acceptanceCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ol>
                </div>
              ) : (
                <EmptyState
                  icon="goals"
                  title="No goal assigned"
                  text="This agent is available for one bounded owner-authorized goal."
                />
              )}
            </div>
            <div className="section-block">
              <div className="section-title">
                <h4>Runtime boundary</h4>
                <span>{childAgents.length} direct reports</span>
              </div>
              <div className="runtime-grid">
                <div className="runtime-card">
                  <small>Workspace</small>
                  {props.detail.workspace ? (
                    <>
                      <strong>{props.detail.workspace.state}</strong>
                      <code>{props.detail.workspace.worktreePath}</code>
                      <span>
                        {props.detail.workspace.mode} · base{" "}
                        {props.detail.workspace.baseRevision.slice(0, 12)}
                      </span>
                      <span>Integration owner {props.detail.workspace.integrationOwnerAgentId}</span>
                    </>
                  ) : (
                    <span>No repository workspace assigned.</span>
                  )}
                </div>
                <div className="runtime-card">
                  <small>Latest OMP lifecycle</small>
                  {latestSession ? (
                    <>
                      <strong>{latestSession.state}</strong>
                      <code>{latestSession.ompSessionId ?? latestSession.sessionId}</code>
                      <span>
                        {latestSession.effectiveProvider ?? latestSession.requestedProvider}/
                        {latestSession.effectiveModel ?? latestSession.requestedModel} ·{" "}
                        {latestSession.reasoning}
                      </span>
                      <span>{latestSession.errorSummary ?? `Route ${latestSession.routeId}`}</span>
                    </>
                  ) : (
                    <span>No OMP process has been started.</span>
                  )}
                </div>
                <div className="runtime-card">
                  <small>Territory and checks</small>
                  <strong>
                    {props.detail.leases.filter((lease) => !lease.releasedAt).length} active leases ·{" "}
                    {props.detail.checkRuns.length} check runs
                  </strong>
                  {props.detail.leases.slice(0, 3).map((lease) => (
                    <span key={lease.leaseId}>
                      {lease.mode} {lease.path} · expires {relativeTime(lease.expiresAt)}
                    </span>
                  ))}
                  {props.detail.leases.length === 0 ? <span>No file territory assigned.</span> : null}
                </div>
              </div>
              {props.detail.workspaceInspection ? (
                <div className="workspace-inspection">
                  <div className="workspace-inspection-heading">
                    <div>
                      <small>Workspace changes</small>
                      <strong>
                        {props.detail.workspaceInspection.changes.length}
                        {props.detail.workspaceInspection.changesTruncated ? "+" : ""} paths
                      </strong>
                    </div>
                    <code>{props.detail.workspaceInspection.currentRevision.slice(0, 12)}</code>
                  </div>
                  {props.detail.workspaceInspection.changes.length > 0 ? (
                    <div className="change-list">
                      {props.detail.workspaceInspection.changes.slice(0, 30).map((change) => (
                        <div key={`${change.indexStatus}${change.workingTreeStatus}:${change.path}`}>
                          <code>{(change.indexStatus + change.workingTreeStatus).replaceAll(" ", "·")}</code>
                          <span title={change.path}>
                            {change.previousPath ? `${change.previousPath} → ` : ""}
                            {change.path}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <pre>{props.detail.workspaceInspection.diffSummary}</pre>
                  <small>Inspected {relativeTime(props.detail.workspaceInspection.inspectedAt)}</small>
                </div>
              ) : null}
            </div>
            <div className="section-block">
              <div className="section-title">
                <h4>Live OMP output</h4>
                <span className="stream-label">
                  <i /> normalized stream
                </span>
              </div>
              <div className="terminal-window">
                <div className="terminal-top">
                  <span />
                  <span />
                  <span />
                  <b>{props.selectedAgent.sessionId ? shortId(props.selectedAgent.sessionId) : "offline"}</b>
                </div>
                <pre>
                  {props.liveText ||
                    latestAssistantText(props.detail.events) ||
                    "No public assistant output in this session yet."}
                </pre>
              </div>
            </div>
            <div className="section-block">
              <div className="section-title">
                <h4>Operational record</h4>
                <span>sanitized and goal-scoped</span>
              </div>
              <div className="detail-ledgers">
                <div>
                  <small>Recent events</small>
                  {props.detail.events.slice(0, 4).map((event) => (
                    <p key={event.eventId}>
                      <StatePill value={event.severity} /> {event.summary}
                    </p>
                  ))}
                  {props.detail.events.length === 0 ? <p>No events recorded.</p> : null}
                </div>
                <div>
                  <small>Messages and handoffs</small>
                  {props.detail.messages.slice(0, 4).map((item) => (
                    <p key={item.messageId}>
                      <StatePill value={item.status} /> {item.senderAgentId} → {item.recipientAgentId}:{" "}
                      {item.content}
                    </p>
                  ))}
                  {props.detail.messages.length === 0 ? <p>No handoffs recorded.</p> : null}
                </div>
                <div>
                  <small>Evidence and checks</small>
                  {props.detail.evidence.slice(0, 2).map((item) => (
                    <p key={item.evidenceId}>
                      <StatePill value={item.result} /> {item.evidenceType}: {item.summary}
                    </p>
                  ))}
                  {props.detail.checkDefinitions.slice(0, 3).map((check) => {
                    const run = props.detail?.checkRuns.find((item) => item.checkId === check.checkId);
                    return (
                      <p key={check.checkId}>
                        <StatePill value={run?.result ?? "registered"} /> {check.label}:{" "}
                        <code>
                          {check.executable} {JSON.stringify(check.arguments)}
                        </code>{" "}
                        · cwd {check.relativeCwd} · {run?.outputSummary ?? "Not run"}
                      </p>
                    );
                  })}
                  {props.detail.evidence.length === 0 && props.detail.checkDefinitions.length === 0 ? (
                    <p>No evidence or checks recorded.</p>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="composer">
              <textarea
                value={props.message}
                onChange={(event) => props.onMessageChange(event.target.value)}
                placeholder={
                  props.detail.role.writeScope === "none"
                    ? "Send a bounded instruction to this exact read-only OMP session…"
                    : "Free-form messages are disabled for write-capable roles."
                }
                disabled={
                  props.busy || props.detail.role.writeScope !== "none" || !props.selectedAgent.sessionId
                }
                maxLength={8_000}
              />
              <div className="composer-actions">
                {!props.selectedAgent.sessionId &&
                !props.selectedAgent.currentGoalId &&
                props.detail.role.kind !== "human" &&
                props.detail.role.writeScope === "none" ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={props.onStart}
                    disabled={props.busy}
                  >
                    <Icon name="play" /> Start read-only session
                  </button>
                ) : null}
                {props.selectedAgent.sessionId ? (
                  <>
                    <button
                      className="danger-ghost"
                      type="button"
                      onClick={props.onInterrupt}
                      disabled={props.busy || props.selectedAgent.sessionState !== "streaming"}
                    >
                      <Icon name="stop" /> Interrupt
                    </button>
                    <button
                      className="danger-ghost"
                      type="button"
                      onClick={props.onCancel}
                      disabled={props.busy}
                    >
                      <Icon name="close" /> Cancel
                    </button>
                  </>
                ) : null}
                <button
                  className="primary-button send-button"
                  type="button"
                  onClick={props.onSend}
                  disabled={
                    props.busy ||
                    !props.message.trim() ||
                    !props.selectedAgent.sessionId ||
                    props.detail.role.writeScope !== "none"
                  }
                >
                  <Icon name="send" /> Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            icon="agent"
            title="Select an agent"
            text="Choose one registered identity to inspect its exact goal, session, tools, evidence, and controls."
          />
        )}
      </article>
    </section>
  );
}

function HierarchyNode({
  node,
  selectedId,
  depth,
  onSelect,
}: {
  node: AgentNode;
  selectedId: string;
  depth: number;
  onSelect(agentId: string): void;
}): ReactNode {
  const [expanded, setExpanded] = useState(depth < 2);
  const depthClass = `tree-depth-${Math.min(depth, 4)}`;
  return (
    <div className="tree-node">
      <div className={`tree-row ${depthClass} ${selectedId === node.agentId ? "selected" : ""}`}>
        <button
          type="button"
          className="expand-button"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? "Collapse" : "Expand"}
          disabled={node.children.length === 0}
        >
          <Icon name="chevron" />
        </button>
        <button type="button" className="tree-agent" onClick={() => onSelect(node.agentId)}>
          <span className={`mini-avatar ${node.kind}`}>{initials(node.displayName)}</span>
          <span>
            <strong>{node.displayName}</strong>
            <small>{node.roleName}</small>
          </span>
          <i className={`status-dot state-${node.state}`} title={STATUS_LABELS[node.state]} />
        </button>
      </div>
      {expanded
        ? node.children.map((child) => (
            <HierarchyNode
              key={child.agentId}
              node={child}
              selectedId={selectedId}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  );
}

function GoalBoard({
  snapshot,
  busy,
  onPrepare,
  onStart,
  onRetry,
  onComplete,
  onRollback,
}: {
  snapshot: DashboardSnapshot | null;
  busy: boolean;
  onPrepare(goal: GoalSummary): void;
  onStart(goalId: string): void;
  onRetry(goalId: string): void;
  onComplete(goalId: string): void;
  onRollback(goalId: string): void;
}): ReactNode {
  const groups: ReadonlyArray<{ title: string; states: GoalSummary["state"][] }> = [
    { title: "Planned", states: ["draft", "queued"] },
    { title: "In progress", states: ["running", "waiting_input", "waiting_approval"] },
    { title: "Verification", states: ["verifying", "blocked"] },
    { title: "Settled", states: ["complete", "failed", "cancelled", "rolled_back"] },
  ];
  const agents = snapshot?.agents ?? [];
  const [confirmRollbackGoalId, setConfirmRollbackGoalId] = useState<string | null>(null);
  const [confirmRetryGoalId, setConfirmRetryGoalId] = useState<string | null>(null);
  return (
    <section className="board-grid">
      {groups.map((group) => {
        const goals = (snapshot?.goals ?? []).filter((goal) => group.states.includes(goal.state));
        return (
          <article className="board-column" key={group.title}>
            <div className="board-heading">
              <h3>{group.title}</h3>
              <span>{goals.length}</span>
            </div>
            <div className="goal-stack">
              {goals.map((goal) => {
                const owner = agents.find((agent) => agent.agentId === goal.ownerAgentId);
                const workspace = snapshot?.workspaces.find(
                  (item) =>
                    item.goalId === goal.goalId && item.state !== "released" && item.state !== "quarantined",
                );
                const needsWorkspace =
                  goal.writeScope === "isolated_repository" &&
                  owner?.roleWriteScope === "isolated" &&
                  !workspace;
                const hasCodeCandidate =
                  goal.writeScope === "isolated_repository" && Boolean(goal.artifactIdentity);
                return (
                  <div className="goal-card" key={goal.goalId}>
                    <div className="goal-card-top">
                      <StatePill value={goal.state} />
                      <span className={`risk risk-${goal.riskLevel}`}>{goal.riskLevel}</span>
                    </div>
                    <h4>{goal.title}</h4>
                    <p>{goal.description}</p>
                    <div className="goal-owner">
                      <span className="mini-avatar specialist">
                        {initials(owner?.displayName ?? goal.ownerAgentId)}
                      </span>
                      <div>
                        <strong>{owner?.displayName ?? goal.ownerAgentId}</strong>
                        <small>
                          {goal.acceptanceCriteria.length} criteria · {goal.requiredChecks.length} checks
                        </small>
                      </div>
                    </div>
                    {goal.state === "draft" ? (
                      <button
                        className="secondary-button full"
                        type="button"
                        disabled={busy}
                        onClick={() => (needsWorkspace ? onPrepare(goal) : onStart(goal.goalId))}
                        title={
                          needsWorkspace
                            ? "Prepare a controller-owned isolated workspace before dispatch"
                            : ""
                        }
                      >
                        <Icon name={needsWorkspace ? "plus" : "play"} />{" "}
                        {needsWorkspace ? "Prepare isolated workspace" : "Dispatch goal"}
                      </button>
                    ) : null}
                    {["blocked", "failed", "cancelled"].includes(goal.state) ? (
                      <button
                        className="secondary-button full"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (confirmRetryGoalId === goal.goalId) {
                            setConfirmRetryGoalId(null);
                            onRetry(goal.goalId);
                          } else {
                            setConfirmRetryGoalId(goal.goalId);
                          }
                        }}
                        title="Starts a new exact OMP attempt; any attached artifact and matching approvals are invalidated first"
                      >
                        <Icon name="play" />{" "}
                        {confirmRetryGoalId === goal.goalId ? "Confirm new OMP attempt" : "Authorize retry"}
                      </button>
                    ) : null}
                    {goal.state === "verifying" ? (
                      <button
                        className="secondary-button full"
                        type="button"
                        disabled={busy}
                        onClick={() => onComplete(goal.goalId)}
                        title={
                          hasCodeCandidate
                            ? "Revalidate exact candidate checks and independent evidence before settling"
                            : "Accept the exact durable agent outcome after reviewing it against the criteria"
                        }
                      >
                        <Icon name="shield" />{" "}
                        {hasCodeCandidate ? "Accept verified completion" : "Accept reviewed outcome"}
                      </button>
                    ) : null}
                    {(goal.artifactIdentity && goal.state === "verifying") ||
                    ["blocked", "failed", "cancelled"].includes(goal.state) ? (
                      <button
                        className="danger-ghost full"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (confirmRollbackGoalId === goal.goalId) {
                            setConfirmRollbackGoalId(null);
                            onRollback(goal.goalId);
                          } else {
                            setConfirmRollbackGoalId(goal.goalId);
                          }
                        }}
                        title={
                          hasCodeCandidate
                            ? "Invalidates this exact candidate and its approvals; preserves evidence and quarantines its workspace"
                            : goal.artifactIdentity
                              ? "Invalidates this exact outcome and preserves its evidence"
                              : "Abandons this attempt, preserves evidence, and quarantines any controller-owned workspace"
                        }
                      >
                        <Icon name="stop" />{" "}
                        {confirmRollbackGoalId === goal.goalId
                          ? hasCodeCandidate
                            ? "Confirm candidate rollback"
                            : goal.artifactIdentity
                              ? "Confirm outcome rollback"
                              : "Confirm abandon attempt"
                          : hasCodeCandidate
                            ? "Withdraw candidate"
                            : goal.artifactIdentity
                              ? "Rollback outcome"
                              : "Abandon attempt"}
                      </button>
                    ) : null}
                  </div>
                );
              })}
              {goals.length === 0 ? <div className="column-empty">No goals in this state</div> : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function ApprovalCenter({
  approvals,
  agents,
  goals,
  busy,
  onDecision,
}: {
  approvals: ApprovalSummary[];
  agents: AgentSummary[];
  goals: GoalSummary[];
  busy: boolean;
  onDecision(approval: ApprovalSummary, decision: "approved" | "rejected", note: string): void;
}): ReactNode {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(approvals.length / APPROVAL_PAGE_SIZE));
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  const visibleApprovals = approvals.slice(page * APPROVAL_PAGE_SIZE, (page + 1) * APPROVAL_PAGE_SIZE);
  if (approvals.length === 0)
    return (
      <div className="wide-empty">
        <EmptyState
          icon="approval"
          title="No approval requests"
          text="Exact, expiring consequential decisions will appear here with artifact and request hashes."
        />
      </div>
    );
  return (
    <>
      <section className="approval-grid">
        {visibleApprovals.map((approval) => {
          const goal = goals.find((item) => item.goalId === approval.goalId);
          const requester = agents.find((agent) => agent.agentId === approval.requestedByAgentId);
          const parent = agents.find((agent) => agent.agentId === requester?.parentAgentId);
          return (
            <article className={`approval-card ${approval.status}`} key={approval.approvalId}>
              <div className="approval-icon">
                <Icon name="approval" />
              </div>
              <div className="approval-content">
                <div className="approval-top">
                  <div>
                    <p className="eyebrow">{approval.action}</p>
                    <h3>{approval.target}</h3>
                    <p>{goal?.description ?? "No goal description available."}</p>
                  </div>
                  <StatePill value={approval.status} />
                </div>
                <dl>
                  <div>
                    <dt>Requested by</dt>
                    <dd>{requester?.displayName ?? approval.requestedByAgentId}</dd>
                  </div>
                  <div>
                    <dt>Parent director</dt>
                    <dd>{parent?.displayName ?? "Human authority"}</dd>
                  </div>
                  <div>
                    <dt>Goal</dt>
                    <dd>{goal?.title ?? approval.goalId}</dd>
                  </div>
                  <div>
                    <dt>Risk</dt>
                    <dd>{approval.riskLevel}</dd>
                  </div>
                  <div>
                    <dt>Artifact</dt>
                    <dd>
                      <code className="full-identity">{approval.artifactHash}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Request hash</dt>
                    <dd>
                      <code className="full-identity">{approval.requestHash}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{relativeTime(approval.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>Invalidation</dt>
                    <dd>Any candidate identity change</dd>
                  </div>
                </dl>
                {approval.status === "pending" ? (
                  <div className="approval-actions">
                    <button
                      type="button"
                      className="danger-ghost"
                      disabled={busy}
                      onClick={() => onDecision(approval, "rejected", "Rejected in local dashboard")}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        onDecision(approval, "rejected", "Changes requested; submit a new exact candidate")
                      }
                    >
                      Request changes
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() =>
                        onDecision(approval, "approved", "Approved exact request in local dashboard")
                      }
                    >
                      <Icon name="shield" /> Approve exact request
                    </button>
                  </div>
                ) : (
                  <p className="decision-note">{approval.decisionNote ?? `Request ${approval.status}`}</p>
                )}
              </div>
            </article>
          );
        })}
      </section>
      <nav className="pagination" aria-label="Approval pages">
        <button
          className="secondary-button"
          type="button"
          disabled={page === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          Previous
        </button>
        <span>
          Page {page + 1} of {pageCount} · {approvals.length} requests
        </span>
        <button
          className="secondary-button"
          type="button"
          disabled={page + 1 >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
        >
          Next
        </button>
      </nav>
    </>
  );
}

function EvidenceCenter({
  evidence,
  goals,
  approvals,
  checkDefinitions,
  checkRuns,
  releaseGates,
}: {
  evidence: EvidenceSummary[];
  goals: GoalSummary[];
  approvals: ApprovalSummary[];
  checkDefinitions: CheckDefinitionSummary[];
  checkRuns: CheckRunSummary[];
  releaseGates: ReleaseGateSummary[];
}): ReactNode {
  const candidateGoals = goals.filter(
    (goal) => goal.writeScope === "isolated_repository" && goal.artifactIdentity,
  );
  return (
    <section className="evidence-layout">
      <article className="panel evidence-main">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Observed record</p>
            <h3>Evidence and check ledger</h3>
          </div>
          <span>
            {evidence.length} evidence · {checkDefinitions.length} registered · {checkRuns.length} runs
          </span>
        </div>
        {evidence.length > 0 ? (
          <div className="evidence-table">
            <div className="table-head">
              <span>Result</span>
              <span>Evidence</span>
              <span>Candidate</span>
              <span>Verifier</span>
              <span>Recorded</span>
            </div>
            {evidence.map((item) => (
              <div className="table-row" key={item.evidenceId}>
                <span>
                  <StatePill value={item.result} />
                </span>
                <span>
                  <strong>{item.evidenceType}</strong>
                  <small>{item.summary}</small>
                  {item.limitations.length > 0 ? <small>Limits: {item.limitations.join("; ")}</small> : null}
                </span>
                <span>
                  <code>{item.candidateIdentity.slice(0, 12)}</code>
                </span>
                <span>{item.verifierAgentId ?? "Unverified"}</span>
                <span>{relativeTime(item.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="evidence"
            title="No evidence recorded"
            text="Only normalized, bounded evidence tied to immutable candidate identities appears here."
          />
        )}
        {checkDefinitions.length > 0 ? (
          <div className="check-ledger">
            {checkDefinitions.slice(0, 20).map((check) => {
              const run = checkRuns.find((item) => item.checkId === check.checkId);
              return (
                <div key={check.checkId}>
                  <StatePill value={run?.result ?? "registered"} />
                  <span>
                    <strong>{check.label}</strong>
                    <small>
                      <code>{check.executable}</code> {JSON.stringify(check.arguments)} · cwd{" "}
                      {check.relativeCwd} · {run?.outputSummary ?? "Not run"}
                    </small>
                  </span>
                  <code>{run?.candidateIdentity.slice(0, 12) ?? "pending"}</code>
                </div>
              );
            })}
          </div>
        ) : null}
      </article>
      <article className="panel release-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Release posture</p>
            <h3>Exact candidate gates</h3>
          </div>
          <Icon name="shield" />
        </div>
        {candidateGoals.map((goal) => {
          const artifact = goal.artifactIdentity as string;
          const gates = releaseGates.filter(
            (gate) => gate.goalId === goal.goalId && gate.artifactHash === artifact,
          );
          const securityFailed = gates.some((gate) => gate.gate === "security" && gate.result === "fail");
          const quality = gates.find((gate) => gate.gate === "quality");
          const security = gates.find((gate) => gate.gate === "security");
          const approval = approvals.find(
            (item) =>
              item.goalId === goal.goalId &&
              item.artifactHash === artifact &&
              item.status === "approved" &&
              ["release", "deployment"].includes(item.action),
          );
          const candidateChecks = checkRuns.filter(
            (run) => run.goalId === goal.goalId && run.candidateIdentity === artifact,
          );
          const requiredChecksPass = goal.requiredChecks.every(
            (requiredCheck) => candidateChecks.find((run) => run.label === requiredCheck)?.result === "pass",
          );
          const ledgerReady =
            goal.state === "complete" &&
            requiredChecksPass &&
            !securityFailed &&
            quality?.result === "pass" &&
            security?.result === "pass" &&
            Boolean(approval);
          return (
            <div className="release-item" key={goal.goalId}>
              <div className="release-title">
                <div>
                  <strong>{goal.title}</strong>
                  <code className="full-identity">{artifact}</code>
                </div>
                <StatePill value={ledgerReady ? "gates_recorded" : "blocked"} />
              </div>
              <div className="gate-grid">
                <span>
                  Quality <StatePill value={quality?.result ?? "missing"} />
                </span>
                <span>
                  Security <StatePill value={securityFailed ? "fail" : (security?.result ?? "missing")} />
                </span>
                <span>
                  Owner <StatePill value={approval?.status ?? "missing"} />
                </span>
                <span>
                  Checks <StatePill value={requiredChecksPass ? "pass" : "missing"} />
                </span>
              </div>
              <p>
                {ledgerReady
                  ? "Ledger prerequisites pass. The controller must recompute this full identity before any owner-operated release."
                  : "Release remains blocked until exact-candidate Quality, Security, and owner gates pass."}
              </p>
              <small>
                Rollback: invalidate this identity, preserve evidence, and create a new candidate.
              </small>
            </div>
          );
        })}
        {candidateGoals.length === 0 ? (
          <EmptyState
            icon="link"
            title="No immutable candidates"
            text="Attach a SHA-256 identity before evidence, approval, or release gates can settle."
          />
        ) : null}
      </article>
    </section>
  );
}

function ImprovementCenter({
  events,
  improvements,
  busy,
  onCreate,
  onTransition,
}: {
  events: EventSummary[];
  improvements: ImprovementReviewSummary[];
  busy: boolean;
  onCreate(input: CreateImprovementRequest): Promise<boolean>;
  onTransition(
    reviewId: string,
    state: Exclude<ImprovementState, "proposed">,
    resultSummary: string,
    limitations: string[],
  ): Promise<boolean>;
}): ReactNode {
  const relevant = events.filter(
    (event) => event.type.includes("failed") || event.type.includes("blocked") || event.severity !== "info",
  );
  const [draft, setDraft] = useState<CreateImprovementRequest>({
    title: "",
    hypothesis: "",
    baseline: "",
    proposedChange: "",
    safetyMetric: "",
    evaluationPlan: "",
    sourceEventIds: [],
  });
  const [transitionNotes, setTransitionNotes] = useState<Record<string, string>>({});
  const [transitionLimitations, setTransitionLimitations] = useState<Record<string, string>>({});
  const stages = [
    { id: "01", title: "Measure", count: relevant.length, detail: relevant[0]?.summary },
    {
      id: "02",
      title: "Propose",
      count: improvements.filter((item) => item.state === "proposed").length,
      detail: improvements.find((item) => item.state === "proposed")?.title,
    },
    {
      id: "03",
      title: "Evaluate",
      count: improvements.filter((item) => ["sandboxed", "evaluated"].includes(item.state)).length,
      detail: improvements.find((item) => ["sandboxed", "evaluated"].includes(item.state))?.resultSummary,
    },
    {
      id: "04",
      title: "Authorize",
      count: improvements.filter((item) =>
        ["canary", "observing", "adopted", "rolled_back"].includes(item.state),
      ).length,
      detail: improvements.find((item) =>
        ["canary", "observing", "adopted", "rolled_back"].includes(item.state),
      )?.resultSummary,
    },
  ] as const;
  const nextState: Partial<Record<ImprovementState, Exclude<ImprovementState, "proposed">>> = {
    proposed: "sandboxed",
    sandboxed: "evaluated",
    evaluated: "canary",
    canary: "observing",
    observing: "adopted",
  };

  return (
    <section className="improvement-layout">
      <article className="improvement-hero">
        <span className="improvement-orbit">
          <Icon name="improve" />
        </span>
        <div>
          <p className="eyebrow">Evidence, not self-modification</p>
          <h3>Bounded improvement loop</h3>
          <p>
            Every proposal binds an observed baseline, hypothesis, safety metric, and evaluation plan to one
            immutable identity. Only the human owner records stage changes; no agent can self-adopt.
          </p>
        </div>
      </article>
      <div className="improvement-steps operational">
        {stages.map((stage) => (
          <div key={stage.id}>
            <b>{stage.id}</b>
            <strong>{stage.title}</strong>
            <span>{stage.count} durable records</span>
            <small>{stage.detail ?? "No observable record yet"}</small>
          </div>
        ))}
      </div>
      <form
        className="panel improvement-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate(draft).then((succeeded) => {
            if (succeeded) {
              setDraft({
                title: "",
                hypothesis: "",
                baseline: "",
                proposedChange: "",
                safetyMetric: "",
                evaluationPlan: "",
                sourceEventIds: [],
              });
            }
          });
        }}
      >
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Owner-authored proposal</p>
            <h3>New improvement review</h3>
          </div>
          <Icon name="plus" />
        </div>
        <label>
          Title
          <input
            required
            maxLength={160}
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </label>
        <div className="improvement-form-grid">
          <label>
            Observable baseline
            <textarea
              required
              maxLength={2_000}
              value={draft.baseline}
              onChange={(event) => setDraft((current) => ({ ...current, baseline: event.target.value }))}
            />
          </label>
          <label>
            Falsifiable hypothesis
            <textarea
              required
              maxLength={2_000}
              value={draft.hypothesis}
              onChange={(event) => setDraft((current) => ({ ...current, hypothesis: event.target.value }))}
            />
          </label>
          <label>
            Proposed bounded change
            <textarea
              required
              maxLength={4_000}
              value={draft.proposedChange}
              onChange={(event) =>
                setDraft((current) => ({ ...current, proposedChange: event.target.value }))
              }
            />
          </label>
          <label>
            Safety metric and rollback trigger
            <textarea
              required
              maxLength={1_000}
              value={draft.safetyMetric}
              onChange={(event) => setDraft((current) => ({ ...current, safetyMetric: event.target.value }))}
            />
          </label>
        </div>
        <label>
          Sandbox, independent evaluation, canary, and observation plan
          <textarea
            required
            maxLength={2_000}
            value={draft.evaluationPlan}
            onChange={(event) => setDraft((current) => ({ ...current, evaluationPlan: event.target.value }))}
          />
        </label>
        <label>
          Source operational signal
          <select
            required
            value={draft.sourceEventIds[0] ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sourceEventIds: event.target.value ? [event.target.value] : [],
              }))
            }
          >
            <option value="">Select one retained warning, failure, or block</option>
            {relevant.map((event) => (
              <option value={event.eventId} key={event.eventId}>
                {event.type} · {event.summary}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" type="submit" disabled={busy || draft.sourceEventIds.length === 0}>
          <Icon name="plus" /> Record immutable proposal
        </button>
      </form>
      <div className="improvement-review-grid">
        {improvements.map((review) => {
          const next = nextState[review.state];
          const rollbackState: Exclude<ImprovementState, "proposed"> | null = [
            "proposed",
            "sandboxed",
            "evaluated",
          ].includes(review.state)
            ? "rejected"
            : ["canary", "observing", "adopted"].includes(review.state)
              ? "rolled_back"
              : null;
          const note = transitionNotes[review.reviewId] ?? "";
          const limitations = transitionLimitations[review.reviewId] ?? "";
          const submitTransition = (state: Exclude<ImprovementState, "proposed">): void => {
            void onTransition(
              review.reviewId,
              state,
              note,
              limitations
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
            ).then((succeeded) => {
              if (succeeded) {
                setTransitionNotes((current) => ({ ...current, [review.reviewId]: "" }));
                setTransitionLimitations((current) => ({ ...current, [review.reviewId]: "" }));
              }
            });
          };
          return (
            <article className="panel improvement-review" key={review.reviewId}>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{review.state.replace("_", " ")}</p>
                  <h3>{review.title}</h3>
                </div>
                <StatePill value={review.state} />
              </div>
              <code className="full-identity" title={review.artifactIdentity}>
                {review.artifactIdentity}
              </code>
              <a
                className="secondary-button improvement-export"
                href={`/api/improvements/${encodeURIComponent(review.reviewId)}/export`}
                download={`improvement-${review.reviewId}.json`}
              >
                Export review record
              </a>
              <dl>
                <div>
                  <dt>Baseline</dt>
                  <dd>{review.baseline}</dd>
                </div>
                <div>
                  <dt>Hypothesis</dt>
                  <dd>{review.hypothesis}</dd>
                </div>
                <div>
                  <dt>Change</dt>
                  <dd>{review.proposedChange}</dd>
                </div>
                <div>
                  <dt>Safety metric</dt>
                  <dd>{review.safetyMetric}</dd>
                </div>
                <div>
                  <dt>Evaluation</dt>
                  <dd>{review.evaluationPlan}</dd>
                </div>
              </dl>
              {review.resultSummary ? <p className="decision-note">{review.resultSummary}</p> : null}
              {next || rollbackState ? (
                <div className="improvement-transition">
                  <label>
                    Observable stage result
                    <textarea
                      required
                      maxLength={2_000}
                      value={note}
                      onChange={(event) =>
                        setTransitionNotes((current) => ({
                          ...current,
                          [review.reviewId]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Limitations, one per line
                    <textarea
                      maxLength={4_000}
                      value={limitations}
                      onChange={(event) =>
                        setTransitionLimitations((current) => ({
                          ...current,
                          [review.reviewId]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="approval-actions">
                    {next ? (
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy || !note.trim()}
                        onClick={() => submitTransition(next)}
                      >
                        Record {next.replace("_", " ")}
                      </button>
                    ) : null}
                    {rollbackState ? (
                      <button
                        className="danger-ghost"
                        type="button"
                        disabled={busy || !note.trim()}
                        onClick={() => submitTransition(rollbackState)}
                      >
                        {rollbackState === "rejected" ? "Reject proposal" : "Record rollback"}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {improvements.length === 0 ? (
        <EmptyState
          icon="improve"
          title="No improvement reviews"
          text="Select retained operational evidence and record a bounded, measurable proposal."
        />
      ) : null}
    </section>
  );
}

function ActivityFeed({
  events,
  agents,
  onSelectAgent,
}: {
  events: EventSummary[];
  agents: AgentSummary[];
  onSelectAgent(agentId: string): void;
}): ReactNode {
  if (events.length === 0)
    return (
      <EmptyState icon="clock" title="No activity yet" text="Normalized lifecycle events will appear here." />
    );
  return (
    <div className="activity-list">
      {events.slice(0, 80).map((event) => {
        const agent = agents.find((candidate) => candidate.agentId === event.agentId);
        return (
          <button
            className="activity-item"
            key={event.eventId}
            type="button"
            onClick={() => event.agentId && onSelectAgent(event.agentId)}
            disabled={!event.agentId}
          >
            <span className={`activity-line ${event.severity}`} />
            <span className="activity-avatar">{initials(agent?.displayName ?? event.agentId ?? "CC")}</span>
            <span className="activity-copy">
              <strong>{agent?.displayName ?? event.agentId ?? "Control Center"}</strong>
              <p>{event.summary}</p>
              <small>
                {relativeTime(event.occurredAt)} · {event.type}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function GoalModal({
  agents,
  busy,
  initialInput,
  onClose,
  onSubmit,
}: {
  agents: AgentSummary[];
  busy: boolean;
  initialInput: AccomplishGoalPrefill | null;
  onClose(): void;
  onSubmit(input: CreateGoalRequest): void;
}): ReactNode {
  const eligible = agents.filter((agent) => agent.kind !== "human" && !agent.archivedAt);
  const [ownerAgentId, setOwnerAgentId] = useState("ORCH-01");
  const [title, setTitle] = useState(initialInput?.task ?? "");
  const [description, setDescription] = useState(initialInput?.description ?? "");
  const [criteria, setCriteria] = useState(initialInput?.outcome ?? "");
  const [riskLevel, setRiskLevel] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [writeScope, setWriteScope] = useState<"none" | "isolated_repository">("none");
  const [requiredChecks, setRequiredChecks] = useState("");
  const selectedOwner = eligible.find((agent) => agent.agentId === ownerAgentId);
  const canAuthorizeRepository = canReceiveRepositoryAuthority(ownerAgentId, agents);
  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    const acceptanceCriteria = criteria
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
    if (!title.trim() || !description.trim() || acceptanceCriteria.length === 0) return;
    onSubmit({
      ownerAgentId,
      title: title.trim(),
      description: description.trim(),
      acceptanceCriteria,
      requiredChecks:
        writeScope === "isolated_repository" && selectedOwner?.roleWriteScope === "isolated"
          ? requiredChecks
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      riskLevel,
      dataClass: "internal",
      writeScope,
      externalEffects: [],
    });
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Owner-authorized work</p>
            <h3>Create bounded goal</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <label>
          Assigned agent
          <select
            value={ownerAgentId}
            onChange={(event) => {
              const nextOwnerAgentId = event.target.value;
              setOwnerAgentId(nextOwnerAgentId);
              if (!canReceiveRepositoryAuthority(nextOwnerAgentId, agents)) {
                setWriteScope("none");
              }
              if (
                eligible.find((agent) => agent.agentId === nextOwnerAgentId)?.roleWriteScope !== "isolated"
              ) {
                setRequiredChecks("");
              }
            }}
          >
            {eligible.map((agent) => (
              <option value={agent.agentId} key={agent.agentId}>
                {agent.displayName} — {agent.roleName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Goal title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            placeholder="A specific observable outcome"
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={4_000}
            placeholder="Scope, context, and explicit exclusions"
          />
        </label>
        <label>
          Acceptance criteria <small>one per line</small>
          <textarea
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            placeholder={"Observable behavior is verified\nNo authority boundary is crossed"}
          />
        </label>
        <div className="form-row">
          <label>
            Risk
            <select
              value={riskLevel}
              onChange={(event) => setRiskLevel(event.target.value as typeof riskLevel)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label>
            Write authority
            <select
              value={writeScope}
              onChange={(event) => {
                const nextWriteScope = event.target.value as typeof writeScope;
                setWriteScope(nextWriteScope);
                if (nextWriteScope === "none") setRequiredChecks("");
              }}
            >
              <option value="none">Read-only</option>
              <option value="isolated_repository" disabled={!canAuthorizeRepository}>
                Isolated repository
              </option>
            </select>
            <small>
              {selectedOwner?.roleWriteScope === "isolated"
                ? "Selected role may receive a controller-owned worktree."
                : canAuthorizeRepository
                  ? "Selected director may delegate this repository authority to a writable descendant."
                  : "Selected role is read-only and has no writable descendants."}
            </small>
          </label>
        </div>
        {writeScope === "isolated_repository" && selectedOwner?.roleWriteScope === "isolated" ? (
          <label>
            Required check labels <small>optional, one per line</small>
            <textarea
              value={requiredChecks}
              onChange={(event) => setRequiredChecks(event.target.value)}
              placeholder={"typecheck\nchanged-scope tests"}
            />
            <small>Exact commands for these labels are pre-authorized when the workspace is prepared.</small>
          </label>
        ) : null}
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !title.trim() || !description.trim() || !criteria.trim()}
          >
            <Icon name="plus" /> Create draft goal
          </button>
        </div>
      </form>
    </div>
  );
}
function canReceiveRepositoryAuthority(agentId: string, agents: readonly AgentSummary[]): boolean {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]));
  return agents.some((candidate) => {
    if (candidate.roleWriteScope !== "isolated") return false;
    let current: AgentSummary | undefined = candidate;
    const visited = new Set<string>();
    while (current) {
      if (current.agentId === agentId) return true;
      if (!current.parentAgentId || visited.has(current.parentAgentId)) return false;
      visited.add(current.parentAgentId);
      current = byId.get(current.parentAgentId);
    }
    return false;
  });
}

function parseWorkspaceChecks(
  labels: readonly string[],
  values: Readonly<Record<string, string>>,
): WorkspaceCheckInput[] | null {
  const allowedExecutables = new Set(["node", "npm", "python", "python3", "pytest", "ruff", "tsc", "vitest"]);
  const checks: WorkspaceCheckInput[] = [];
  try {
    for (const label of labels) {
      const parsed: unknown = JSON.parse(values[label] ?? "");
      if (
        !Array.isArray(parsed) ||
        parsed.length < 1 ||
        parsed.length > 41 ||
        parsed.some((item) => typeof item !== "string" || item.length > 500) ||
        !allowedExecutables.has(parsed[0] as string)
      ) {
        return null;
      }
      checks.push({
        label,
        executable: parsed[0] as string,
        arguments: parsed.slice(1) as string[],
        relativeCwd: ".",
        timeoutMs: 900_000,
      });
    }
    return checks;
  } catch {
    return null;
  }
}

function WorkspaceModal({
  goal,
  busy,
  onClose,
  onSubmit,
}: {
  goal: GoalSummary;
  busy: boolean;
  onClose(): void;
  onSubmit(
    repositoryPath: string,
    baseRef: string,
    territoryPath: string,
    checks: WorkspaceCheckInput[],
  ): void;
}): ReactNode {
  const [repositoryPath, setRepositoryPath] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [territoryPath, setTerritoryPath] = useState("");
  const [checkCommands, setCheckCommands] = useState<Record<string, string>>(() =>
    Object.fromEntries(goal.requiredChecks.map((label) => [label, ""])),
  );
  const checks = parseWorkspaceChecks(goal.requiredChecks, checkCommands);
  const valid =
    repositoryPath.trim().startsWith("/") &&
    Boolean(baseRef.trim()) &&
    Boolean(territoryPath.trim()) &&
    checks !== null;
  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault();
    if (!valid) return;
    onSubmit(repositoryPath.trim(), baseRef.trim(), territoryPath.trim(), checks ?? []);
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" onSubmit={submit}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">Repository boundary</p>
            <h3>Prepare isolated workspace</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="workspace-warning">
          <Icon name="shield" />
          <p>
            This creates a detached worktree for <strong>{goal.title}</strong>. It does not start OMP, modify
            the primary worktree, push, merge, or deploy.
          </p>
        </div>
        <label>
          Absolute repository path
          <input
            value={repositoryPath}
            onChange={(event) => setRepositoryPath(event.target.value)}
            maxLength={2_000}
            placeholder="/absolute/path/to/repository"
          />
        </label>
        <label>
          Exact base ref
          <input
            value={baseRef}
            onChange={(event) => setBaseRef(event.target.value)}
            maxLength={200}
            placeholder="HEAD or an exact commit"
          />
          <small>
            The controller resolves and records the immutable commit before creating the worktree.
          </small>
        </label>
        <label>
          Initial write territory
          <input
            value={territoryPath}
            onChange={(event) => setTerritoryPath(event.target.value)}
            maxLength={500}
            placeholder="src/client or . for the whole worktree"
          />
          <small>
            The one-hour lease limits which relative path this agent may modify. Prefer the narrowest
            directory that satisfies the goal.
          </small>
        </label>
        {goal.requiredChecks.length > 0 ? (
          <div className="check-command-list">
            <p className="eyebrow">Pre-authorized exact checks</p>
            {goal.requiredChecks.map((label) => (
              <label key={label}>
                {label}
                <input
                  value={checkCommands[label] ?? ""}
                  onChange={(event) =>
                    setCheckCommands((current) => ({ ...current, [label]: event.target.value }))
                  }
                  maxLength={4_000}
                  placeholder={'["npm","run","typecheck"]'}
                />
              </label>
            ))}
            <small>
              Enter each command as a JSON string array. Allowed executables: node, npm, python, python3,
              pytest, ruff, tsc, vitest. Checks run without network access.
            </small>
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={busy || !valid}>
            <Icon name="plus" /> Prepare workspace
          </button>
        </div>
      </form>
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <small>{label}</small>
      <strong title={value}>{value}</strong>
    </div>
  );
}
function StatusBadge({ state, stale = false }: { state: AgentState; stale?: boolean }): ReactNode {
  return (
    <span className={`status-badge state-${state}${stale ? " stale" : ""}`}>
      <i />
      {stale ? "Unresponsive" : STATUS_LABELS[state]}
    </span>
  );
}
function StatePill({ value }: { value: string }): ReactNode {
  return <span className={`state-pill value-${value}`}>{value.replaceAll("_", " ")}</span>;
}
function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }): ReactNode {
  return (
    <div className="empty-state">
      <span>
        <Icon name={icon} />
      </span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function Toast({
  tone,
  message,
  onClose,
}: {
  tone: "error" | "success";
  message: string;
  onClose(): void;
}): ReactNode {
  return (
    <div className={`toast ${tone}`} role="status">
      <Icon name={tone === "error" ? "shield" : "evidence"} />
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss">
        <Icon name="close" />
      </button>
    </div>
  );
}
function LoadingScreen(): ReactNode {
  return (
    <div className="loading-screen">
      <div className="brand-mark large">
        <span>A</span>
      </div>
      <p className="eyebrow">ACCOMP-lish</p>
      <h1>Connecting to the local control plane</h1>
      <span className="loading-bar">
        <i />
      </span>
    </div>
  );
}

function Icon({ name }: { name: IconName }): ReactNode {
  const paths: Readonly<Record<IconName, ReactNode>> = {
    command: (
      <>
        <path d="M4 5h16v11H4z" />
        <path d="M8 20h8M12 16v4" />
      </>
    ),
    goals: (
      <>
        <path d="M5 4h14v16H5z" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    approval: (
      <>
        <path d="M12 3l8 4v5c0 5-3.4 8-8 9-4.6-1-8-4-8-9V7z" />
        <path d="M8.5 12l2.2 2.2L16 9" />
      </>
    ),
    evidence: (
      <>
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M14 3v4h4M9 12l2 2 4-4M9 18h6" />
      </>
    ),
    improve: (
      <>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        <circle cx="12" cy="12" r="5" />
        <path d="M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
      </>
    ),
    agent: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c.5-5 3-7 8-7s7.5 2 8 7" />
      </>
    ),
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3l8 4v5c0 5-3.4 8-8 9-4.6-1-8-4-8-9V7z" />
        <path d="M12 8v5M12 17h.01" />
      </>
    ),
    chevron: <path d="M9 6l6 6-6 6" />,
    send: (
      <>
        <path d="M3 11l18-8-8 18-2-8z" />
        <path d="M11 13L21 3" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    play: <path d="M7 4l13 8-13 8z" />,
    refresh: (
      <>
        <path d="M20 7v5h-5" />
        <path d="M19 12a7 7 0 10-2 5" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6L6 18" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M16 16l5 5" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" />
        <path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" />
      </>
    ),
  };
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function viewTitle(view: View): string {
  return {
    session: "One exact OMP session, cryptographically bound",
    cloud: "Your agent team, alive in the cloud",
    command: "Supervise every agent from one trusted surface",
    goals: "Bounded goals, visible ownership",
    approvals: "Human authority stays explicit",
    evidence: "Immutable candidates and independent proof",
    improvement: "Learn safely from operational evidence",
  }[view];
}
function viewDescription(view: View): string {
  return {
    session:
      "Use OMP's encrypted collaboration channel for transcript, prompting, interruption, and subagent control.",
    cloud: "Watch agents work, wait, hand off, and ask for your attention without opening the engine room.",
    command: "Exact OMP sessions, current work, blockers, messages, and evidence—without terminal hunting.",
    goals: "Track each goal from owner-authorized draft through independent verification and settlement.",
    approvals:
      "Approve or reject exact actions and artifact identities. Any mutation invalidates the decision.",
    evidence: "Review bounded evidence, limitations, checks, and release posture for each candidate.",
    improvement: "Turn recurring friction into measured, reversible proposals—not autonomous authority.",
  }[view];
}
function initials(value: string): string {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "—"
  );
}
function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
function relativeTime(value: string | null): string {
  if (!value) return "Never";
  const difference = Date.parse(value) - Date.now();
  const absolute = Math.abs(difference);
  if (absolute < 60_000) return difference > 0 ? "in moments" : "just now";
  const minutes = Math.round(absolute / 60_000);
  if (minutes < 60) return difference > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return difference > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return difference > 0 ? `in ${days}d` : `${days}d ago`;
}
function latestAssistantText(events: EventSummary[]): string {
  return events.find((event) => event.type === "assistant.message")?.summary ?? "";
}
function errorMessage(error: unknown): string {
  if (error instanceof DashboardApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}
