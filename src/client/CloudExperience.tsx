import type { CSSProperties, ReactNode } from "react";
import type {
  AgentDetail,
  AgentNode,
  AgentState,
  AgentSummary,
  DashboardSnapshot,
  MessageSummary,
} from "../shared/contracts.js";

interface CloudExperienceProps {
  snapshot: DashboardSnapshot;
  selectedAgent: AgentSummary | null;
  detail: AgentDetail | null;
  connected: boolean;
  onSelect(agentId: string): void;
  onClose(): void;
  onNewGoal(): void;
  onAdvanced(): void;
}

const ACTIVE_STATES = new Set<AgentState>([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "verifying",
]);

export function CloudExperience(props: CloudExperienceProps): ReactNode {
  const owner =
    props.snapshot.hierarchy.find((agent) => agent.kind === "human") ?? props.snapshot.hierarchy[0];
  const orchestrator =
    owner?.children.find((agent) => agent.agentId === "ORCH-01") ?? owner?.children[0] ?? null;
  const divisions = orchestrator ? orchestrator.children : (owner?.children ?? []);
  const visibleMessages = props.snapshot.messages.slice(0, 4);
  const selectedMessages = props.selectedAgent
    ? props.snapshot.messages
        .filter(
          (message) =>
            message.senderAgentId === props.selectedAgent?.agentId ||
            message.recipientAgentId === props.selectedAgent?.agentId,
        )
        .slice(0, 3)
    : [];
  const selectedEvent = props.selectedAgent
    ? props.snapshot.events.find((event) => event.agentId === props.selectedAgent?.agentId)
    : null;
  const selectedParent = props.selectedAgent
    ? props.snapshot.agents.find((agent) => agent.agentId === props.selectedAgent?.parentAgentId)
    : null;
  const selectedChildren = props.selectedAgent
    ? props.snapshot.agents.filter((agent) => agent.parentAgentId === props.selectedAgent?.agentId)
    : [];
  const selectedGoal = props.selectedAgent?.currentGoalId
    ? props.snapshot.goals.find((goal) => goal.goalId === props.selectedAgent?.currentGoalId)
    : null;
  const linkedAgentIds = new Set(
    selectedMessages.flatMap((message) => [message.senderAgentId, message.recipientAgentId]),
  );

  return (
    <section className="cloud-experience">
      <header className="cloud-welcome">
        <div>
          <p className="cloud-kicker">{props.snapshot.controller.organizationName} agent cloud</p>
          <h2>See who is working, waiting, and talking.</h2>
          <p className="cloud-welcome-copy">
            Every robot is a real registered role. It wakes only for bounded OMP work and reports its actual
            state—no guessed activity.
          </p>
        </div>
        <button className="cloud-new-mission" type="button" onClick={props.onNewGoal}>
          <span aria-hidden="true">+</span>
          New mission
        </button>
      </header>

      <section className="cloud-summary" aria-label="Agent cloud status">
        <CloudSummaryItem
          tone={props.connected ? "online" : "offline"}
          label={props.connected ? "Cloud connected" : "Reconnecting"}
          value={props.connected ? "Live" : "—"}
        />
        <CloudSummaryItem
          tone="working"
          label="Robots working"
          value={String(props.snapshot.counts.activeAgents)}
        />
        <CloudSummaryItem
          tone="approval"
          label="Need your approval"
          value={String(props.snapshot.counts.waitingApprovals)}
        />
        <CloudSummaryItem
          tone="blocked"
          label="Need help"
          value={String(props.snapshot.counts.blockedItems)}
        />
      </section>

      <div className="cloud-world">
        <span className="ambient-cloud ambient-cloud-one" aria-hidden="true" />
        <span className="ambient-cloud ambient-cloud-two" aria-hidden="true" />
        <span className="ambient-cloud ambient-cloud-three" aria-hidden="true" />

        <div className="cloud-command-chain">
          {owner ? (
            <button
              className={`human-cloud ${props.selectedAgent?.agentId === owner.agentId ? "selected" : ""}`}
              type="button"
              onClick={() => props.onSelect(owner.agentId)}
              aria-label={`${owner.displayName}, human authority`}
            >
              <span className="human-cloud-halo" aria-hidden="true">
                <span>{initials(owner.displayName)}</span>
              </span>
              <strong>{owner.displayName}</strong>
              <small>Human authority</small>
            </button>
          ) : null}

          <div
            className={`cloud-connector owner-connector ${props.snapshot.counts.activeAgents > 0 ? "live" : ""}`}
            aria-hidden="true"
          >
            <i />
          </div>

          {orchestrator ? (
            <CloudAgent
              agent={orchestrator}
              variant="orchestrator"
              selected={props.selectedAgent?.agentId === orchestrator.agentId}
              linked={linkedAgentIds.has(orchestrator.agentId)}
              onSelect={props.onSelect}
            />
          ) : null}

          <div
            className={`cloud-connector branch-connector ${visibleMessages.length > 0 ? "live" : ""}`}
            aria-hidden="true"
          >
            <i />
          </div>
        </div>

        <section className="cloud-divisions" aria-label="Agent departments">
          {divisions.map((division, index) => {
            const specialists = descendants(division.children);
            const divisionIsActive = [division, ...specialists].some((agent) =>
              ACTIVE_STATES.has(agent.state),
            );
            return (
              <article
                className={`division-cloud ${divisionIsActive ? "active" : "quiet"}`}
                key={division.agentId}
                style={{ "--cloud-delay": `${index * 70}ms` } as CSSProperties}
              >
                <span className="division-signal" aria-hidden="true" />
                <CloudAgent
                  agent={division}
                  variant="director"
                  selected={props.selectedAgent?.agentId === division.agentId}
                  linked={linkedAgentIds.has(division.agentId)}
                  onSelect={props.onSelect}
                />
                {specialists.length > 0 ? (
                  <div className="specialist-robots">
                    {specialists.map((specialist) => (
                      <CloudAgent
                        agent={specialist}
                        variant="specialist"
                        selected={props.selectedAgent?.agentId === specialist.agentId}
                        linked={linkedAgentIds.has(specialist.agentId)}
                        onSelect={props.onSelect}
                        key={specialist.agentId}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="solo-cloud-copy">This robot handles its own focused missions.</p>
                )}
              </article>
            );
          })}
        </section>
      </div>

      <section className="cloud-handoffs" aria-labelledby="cloud-handoffs-title">
        <div className="cloud-section-heading">
          <div>
            <p className="cloud-kicker">Signals in flight</p>
            <h3 id="cloud-handoffs-title">Latest agent handoffs</h3>
          </div>
          <span>{visibleMessages.length > 0 ? `${visibleMessages.length} recent` : "Cloud is quiet"}</span>
        </div>
        {visibleMessages.length > 0 ? (
          <div className="handoff-list">
            {visibleMessages.map((message) => (
              <HandoffMessage
                message={message}
                agents={props.snapshot.agents}
                onSelect={props.onSelect}
                key={message.messageId}
              />
            ))}
          </div>
        ) : (
          <div className="quiet-handoff">
            <span className="quiet-signal" aria-hidden="true" />
            <div>
              <strong>No messages are moving right now.</strong>
              <p>When one robot hands work to another, the signal will appear here.</p>
            </div>
          </div>
        )}
      </section>

      {props.selectedAgent ? (
        <>
          <button
            className="cloud-drawer-backdrop"
            type="button"
            onClick={props.onClose}
            aria-label="Close agent card"
          />
          <aside className="cloud-agent-drawer" aria-label={`${props.selectedAgent.displayName} details`}>
            <div className="drawer-handle" aria-hidden="true" />
            <header className="cloud-drawer-header">
              <RobotAvatar state={props.selectedAgent.state} compact />
              <div>
                <p className="cloud-kicker">{props.selectedAgent.agentId}</p>
                <h3>{props.selectedAgent.displayName}</h3>
                <span>{props.selectedAgent.roleName}</span>
              </div>
              <button className="cloud-close-button" type="button" onClick={props.onClose} aria-label="Close">
                ×
              </button>
            </header>

            <div className={`drawer-state state-${props.selectedAgent.state}`}>
              <span />
              {friendlyState(props.selectedAgent)}
            </div>

            <section className="drawer-mission">
              <small>Current mission</small>
              <strong>
                {selectedGoal?.title ?? props.selectedAgent.currentGoalTitle ?? "Ready for a new mission"}
              </strong>
              <p>
                {selectedGoal?.description ??
                  props.detail?.role.mission ??
                  "This robot is standing by for one bounded assignment."}
              </p>
            </section>

            <dl className="drawer-facts">
              <div>
                <dt>Reports to</dt>
                <dd>{selectedParent?.displayName ?? props.snapshot.controller.ownerDisplayName}</dd>
              </div>
              <div>
                <dt>Direct reports</dt>
                <dd>{selectedChildren.length}</dd>
              </div>
              <div>
                <dt>Last signal</dt>
                <dd>{relativeTime(props.selectedAgent.lastHeartbeatAt)}</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>{props.selectedAgent.workspaceId ? "Isolated" : "None"}</dd>
              </div>
            </dl>

            <section className="drawer-signals">
              <div className="drawer-section-title">
                <h4>Recent signals</h4>
                <span>{selectedMessages.length}</span>
              </div>
              {selectedMessages.length > 0 ? (
                selectedMessages.map((message) => {
                  const counterpartId =
                    message.senderAgentId === props.selectedAgent?.agentId
                      ? message.recipientAgentId
                      : message.senderAgentId;
                  const counterpart = props.snapshot.agents.find((agent) => agent.agentId === counterpartId);
                  return (
                    <div className="drawer-signal" key={message.messageId}>
                      <span aria-hidden="true">↗</span>
                      <div>
                        <strong>{counterpart?.displayName ?? counterpartId}</strong>
                        <p>{message.content}</p>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="drawer-empty-copy">No agent messages recorded for this robot yet.</p>
              )}
              {selectedEvent ? (
                <div className="drawer-latest-event">
                  <small>Latest lifecycle event</small>
                  <p>{selectedEvent.summary}</p>
                </div>
              ) : null}
            </section>

            <button className="drawer-advanced-button" type="button" onClick={props.onAdvanced}>
              Open advanced controls
              <span aria-hidden="true">→</span>
            </button>
          </aside>
        </>
      ) : null}
    </section>
  );
}

function CloudSummaryItem({
  tone,
  label,
  value,
}: {
  tone: "online" | "offline" | "working" | "approval" | "blocked";
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className={`cloud-summary-item ${tone}`}>
      <span className="cloud-summary-dot" aria-hidden="true" />
      <strong>{value}</strong>
      <small>{label}</small>
    </div>
  );
}

function CloudAgent({
  agent,
  variant,
  selected,
  linked,
  onSelect,
}: {
  agent: AgentSummary;
  variant: "orchestrator" | "director" | "specialist";
  selected: boolean;
  linked: boolean;
  onSelect(agentId: string): void;
}): ReactNode {
  return (
    <button
      className={`cloud-agent cloud-agent-${variant} state-${agent.state} ${selected ? "selected" : ""} ${
        linked ? "linked" : ""
      }`}
      type="button"
      onClick={() => onSelect(agent.agentId)}
      aria-label={`${agent.displayName}, ${friendlyState(agent)}`}
    >
      <span className="robot-cloud" aria-hidden="true">
        <i className="cloud-bubble cloud-bubble-one" />
        <i className="cloud-bubble cloud-bubble-two" />
        <i className="cloud-bubble cloud-bubble-three" />
        <RobotAvatar state={agent.state} compact={variant === "specialist"} />
      </span>
      <span className="cloud-agent-copy">
        <strong>{agent.displayName}</strong>
        <small>{friendlyState(agent)}</small>
        {variant !== "specialist" ? (
          <em>
            {agent.currentGoalTitle ?? (agent.kind === "director" ? "Coordinating its team" : agent.roleName)}
          </em>
        ) : null}
      </span>
    </button>
  );
}

function RobotAvatar({ state, compact = false }: { state: AgentState; compact?: boolean }): ReactNode {
  return (
    <span className={`cloud-robot state-${state} ${compact ? "compact" : ""}`} aria-hidden="true">
      <span className="robot-antenna">
        <i />
      </span>
      <span className="robot-head">
        <i className="robot-ear robot-ear-left" />
        <i className="robot-ear robot-ear-right" />
        <span className="robot-face">
          <i className="robot-eye robot-eye-left" />
          <i className="robot-eye robot-eye-right" />
          <i className="robot-mouth" />
        </span>
      </span>
      <span className="robot-body">
        <i className="robot-chest" />
        <i className="robot-arm robot-arm-left" />
        <i className="robot-arm robot-arm-right" />
        <i className="robot-foot robot-foot-left" />
        <i className="robot-foot robot-foot-right" />
      </span>
    </span>
  );
}

function HandoffMessage({
  message,
  agents,
  onSelect,
}: {
  message: MessageSummary;
  agents: AgentSummary[];
  onSelect(agentId: string): void;
}): ReactNode {
  const sender = agents.find((agent) => agent.agentId === message.senderAgentId);
  const recipient = agents.find((agent) => agent.agentId === message.recipientAgentId);
  return (
    <article className={`handoff-message ${message.status}`}>
      <button type="button" onClick={() => onSelect(message.senderAgentId)}>
        <span>{initials(sender?.displayName ?? message.senderAgentId)}</span>
        <strong>{sender?.displayName ?? message.senderAgentId}</strong>
      </button>
      <div className="handoff-flight" aria-hidden="true">
        <i />
        <span>→</span>
      </div>
      <button type="button" onClick={() => onSelect(message.recipientAgentId)}>
        <span>{initials(recipient?.displayName ?? message.recipientAgentId)}</span>
        <strong>{recipient?.displayName ?? message.recipientAgentId}</strong>
      </button>
      <p>{message.content}</p>
      <small>{relativeTime(message.createdAt)}</small>
    </article>
  );
}

function descendants(children: AgentNode[]): AgentNode[] {
  return children.flatMap((child) => [child, ...descendants(child.children)]);
}

function friendlyState(agent: AgentSummary): string {
  if (agent.state === "idle" && !agent.currentGoalId) return "Waiting for commands";
  return {
    idle: "Idle",
    queued: "Getting ready",
    running: "Working",
    waiting_input: "Waiting for input",
    waiting_approval: "Needs your approval",
    verifying: "Checking work",
    blocked: "Blocked",
    failed: "Needs help",
    complete: "Mission complete",
    disconnected: "Connection lost",
    paused: "Paused",
    cancelled: "Stopped",
  }[agent.state];
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

function relativeTime(value: string | null): string {
  if (!value) return "No signal yet";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "just now";
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
