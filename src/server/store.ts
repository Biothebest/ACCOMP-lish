import { randomUUID } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  AgentDetail,
  AgentNode,
  AgentState,
  AgentSummary,
  ApprovalStatus,
  ApprovalSummary,
  CheckDefinitionSummary,
  CheckRunSummary,
  DashboardSnapshot,
  DataClass,
  EventSummary,
  EvidenceResult,
  EvidenceSummary,
  GoalState,
  GoalSummary,
  ImprovementReviewSummary,
  ImprovementState,
  MessageSummary,
  ReleaseGateSummary,
  RiskLevel,
  SessionState,
  SessionSummary,
  TerritoryLeaseSummary,
  WorkspaceSummary,
} from "../shared/contracts.js";
import { getRoleContract } from "./roles.js";
import { canonicalJson, sanitizeMetadata, sanitizeText, sha256 } from "./security.js";

interface ControllerSnapshotMetadata {
  version: string;
  organizationName: string;
  ownerDisplayName: string;
  policyVersion: string;
  roleContractVersion: string;
  host: string;
  port: number;
  ompPath: string;
  ompVersion: string | null;
}

interface CreateGoalInput {
  goalId?: string;
  parentGoalId?: string | null;
  ownerAgentId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredChecks: string[];
  riskLevel: RiskLevel;
  dataClass: DataClass;
  writeScope: GoalSummary["writeScope"];
  externalEffects: string[];
  authorizedBy: string | null;
}

interface CreateSessionInput {
  sessionId: string;
  agentId: string;
  goalId: string | null;
  requestedProvider: string;
  requestedModel: string;
  reasoning: string;
  routeId: string;
  modelPolicyVersion: string;
  modelDecision: Record<string, unknown>;
  workspaceId: string | null;
}

const GOAL_TRANSITIONS: Readonly<Record<GoalState, readonly GoalState[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["running", "blocked", "cancelled", "failed", "rolled_back"],
  running: [
    "waiting_input",
    "waiting_approval",
    "verifying",
    "blocked",
    "cancelled",
    "failed",
    "rolled_back",
  ],
  waiting_input: ["running", "blocked", "cancelled", "failed", "rolled_back"],
  waiting_approval: ["running", "verifying", "blocked", "cancelled", "failed", "rolled_back"],
  verifying: ["running", "waiting_approval", "blocked", "cancelled", "failed", "rolled_back", "complete"],
  blocked: ["queued", "running", "cancelled", "failed", "rolled_back"],
  failed: ["queued", "rolled_back"],
  cancelled: ["queued", "rolled_back"],
  rolled_back: [],
  complete: [],
};

const ACTIVE_AGENT_STATES: Readonly<Record<AgentState, boolean>> = {
  idle: false,
  queued: true,
  running: true,
  waiting_input: true,
  waiting_approval: true,
  verifying: true,
  blocked: false,
  failed: false,
  complete: false,
  disconnected: false,
  paused: false,
  cancelled: false,
};

function identifier(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Stored JSON array is invalid");
  }
  return parsed;
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Stored metadata is invalid");
  }
  return parsed as Record<string, unknown>;
}

export class ControlStore {
  constructor(
    readonly database: DatabaseType,
    private readonly onEvent?: (event: EventSummary) => void,
  ) {}
  recordEvent(input: {
    type: string;
    summary: string;
    severity?: EventSummary["severity"];
    agentId?: string | null;
    goalId?: string | null;
    sessionId?: string | null;
    metadata?: Record<string, unknown>;
  }): EventSummary {
    const eventId = identifier("evt");
    const occurredAt = new Date().toISOString();
    const summary = sanitizeText(input.summary, 500);
    const rawMetadata = input.metadata ?? {};
    const sanitizedMetadata = sanitizeMetadata(rawMetadata) as Record<string, unknown>;
    const goalContext = input.goalId
      ? (this.database
          .prepare("SELECT parent_goal_id AS parentGoalId FROM goals WHERE goal_id = ?")
          .get(input.goalId) as { parentGoalId: string | null } | undefined)
      : undefined;
    const sessionContext = input.sessionId
      ? (this.database
          .prepare("SELECT omp_session_id AS ompSessionId FROM sessions WHERE session_id = ?")
          .get(input.sessionId) as { ompSessionId: string | null } | undefined)
      : undefined;
    const filePaths = stringArray(sanitizedMetadata.filePaths);
    const singlePath = stringOrNull(sanitizedMetadata.path);
    if (filePaths.length === 0 && singlePath) {
      filePaths.push(singlePath);
    }
    const evidenceRefs = stringArray(sanitizedMetadata.evidenceRefs);
    const evidenceId = stringOrNull(sanitizedMetadata.evidenceId);
    if (evidenceRefs.length === 0 && evidenceId) {
      evidenceRefs.push(evidenceId);
    }
    const metadata: Record<string, unknown> = {
      ...sanitizedMetadata,
      parentGoalId: goalContext?.parentGoalId ?? null,
      ompSessionId: sessionContext?.ompSessionId ?? null,
      statusBefore: stringOrNull(sanitizedMetadata.statusBefore ?? sanitizedMetadata.from),
      statusAfter: stringOrNull(sanitizedMetadata.statusAfter ?? sanitizedMetadata.to),
      toolName: stringOrNull(sanitizedMetadata.toolName),
      workspaceId: stringOrNull(sanitizedMetadata.workspaceId),
      filePaths,
      commandSummary: stringOrNull(sanitizedMetadata.commandSummary),
      evidenceRefs,
      approvalRequestId: stringOrNull(sanitizedMetadata.approvalRequestId ?? sanitizedMetadata.approvalId),
      redactionApplied: JSON.stringify(rawMetadata) !== JSON.stringify(sanitizedMetadata),
      sourceEventVersion: 1,
    };
    const result = this.database
      .prepare(`
        INSERT INTO events (
          event_id, occurred_at, agent_id, goal_id, session_id, type, severity, summary, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        occurredAt,
        input.agentId ?? null,
        input.goalId ?? null,
        input.sessionId ?? null,
        input.type,
        input.severity ?? "info",
        summary,
        JSON.stringify(metadata),
      );
    const event = eventFromMetadata(
      {
        eventId,
        sequence: Number(result.lastInsertRowid),
        occurredAt,
        agentId: input.agentId ?? null,
        goalId: input.goalId ?? null,
        sessionId: input.sessionId ?? null,
        type: input.type,
        severity: input.severity ?? "info",
        summary,
      },
      metadata,
    );
    this.onEvent?.(event);
    return event;
  }

  createGoal(input: CreateGoalInput): GoalSummary {
    const goalId = input.goalId ?? identifier("goal");
    const now = new Date().toISOString();
    if (!input.title.trim() || !input.description.trim() || input.acceptanceCriteria.length === 0) {
      throw new Error("Goal title, description, and acceptance criteria are required");
    }
    const roleRow = this.database
      .prepare("SELECT role_id AS roleId FROM agents WHERE agent_id = ? AND archived_at IS NULL")
      .get(input.ownerAgentId) as { roleId: string } | undefined;
    if (!roleRow) {
      throw new Error(`Unknown active owner agent: ${input.ownerAgentId}`);
    }
    if (getRoleContract(roleRow.roleId).kind === "human") {
      throw new Error("Human owner cannot be assigned an OMP goal");
    }

    const insert = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO goals (
            goal_id, parent_goal_id, owner_agent_id, title, description, acceptance_criteria_json,
            required_checks_json, state, risk_level, data_class, write_scope, external_effects_json,
            authorized_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          goalId,
          input.parentGoalId ?? null,
          input.ownerAgentId,
          sanitizeText(input.title, 160),
          sanitizeText(input.description, 4_000),
          JSON.stringify(input.acceptanceCriteria.map((item) => sanitizeText(item, 500))),
          JSON.stringify(input.requiredChecks.map((item) => sanitizeText(item, 160))),
          input.riskLevel,
          input.dataClass,
          input.writeScope,
          JSON.stringify(input.externalEffects),
          input.authorizedBy,
          now,
          now,
        );
      this.recordEvent({
        type: "goal.created",
        summary: `Goal created for ${input.ownerAgentId}: ${input.title}`,
        agentId: input.ownerAgentId,
        goalId,
        metadata: {
          parentGoalId: input.parentGoalId ?? null,
          riskLevel: input.riskLevel,
          dataClass: input.dataClass,
          writeScope: input.writeScope,
        },
      });
    });
    insert();
    return this.getGoal(goalId);
  }

  getGoal(goalId: string): GoalSummary {
    const row = this.database
      .prepare(`
        SELECT
          goal_id AS goalId, parent_goal_id AS parentGoalId, owner_agent_id AS ownerAgentId,
          title, description, acceptance_criteria_json AS acceptanceCriteriaJson,
          required_checks_json AS requiredChecksJson, state, risk_level AS riskLevel,
          data_class AS dataClass, write_scope AS writeScope,
          external_effects_json AS externalEffectsJson, authorized_by AS authorizedBy,
          artifact_identity AS artifactIdentity, created_at AS createdAt, updated_at AS updatedAt
        FROM goals WHERE goal_id = ?
      `)
      .get(goalId) as GoalRow | undefined;
    if (!row) {
      throw new Error(`Unknown goal: ${goalId}`);
    }
    return goalFromRow(row);
  }

  transitionGoal(goalId: string, nextState: GoalState, reason: string, actorAgentId: string): GoalSummary {
    const current = this.getGoal(goalId);
    if (!GOAL_TRANSITIONS[current.state].includes(nextState)) {
      throw new Error(`Invalid goal transition: ${current.state} -> ${nextState}`);
    }
    const now = new Date().toISOString();
    const transition = this.database.transaction(() => {
      const result = this.database
        .prepare("UPDATE goals SET state = ?, updated_at = ? WHERE goal_id = ? AND state = ?")
        .run(nextState, now, goalId, current.state);
      if (result.changes !== 1) {
        throw new Error("Goal state changed concurrently");
      }
      this.database
        .prepare(`
          UPDATE agents
          SET state = ?, current_goal_id = CASE WHEN ? IN ('complete', 'cancelled', 'failed', 'rolled_back') THEN NULL ELSE ? END,
              status_reason = ?, last_heartbeat_at = ?
          WHERE agent_id = ?
        `)
        .run(
          agentStateForGoal(nextState),
          nextState,
          goalId,
          sanitizeText(reason, 300),
          now,
          current.ownerAgentId,
        );
      this.recordEvent({
        type: "goal.transition",
        summary: `${current.state} → ${nextState}: ${reason}`,
        agentId: actorAgentId,
        goalId,
        metadata: { from: current.state, to: nextState, ownerAgentId: current.ownerAgentId },
      });
    });
    transition();
    return this.getGoal(goalId);
  }

  attachArtifact(goalId: string, artifactIdentity: string, actorAgentId: string): GoalSummary {
    const identity = artifactIdentity.trim();
    if (!/^[a-f0-9]{64}$/i.test(identity)) {
      throw new Error("Artifact identity must be a SHA-256 hex digest");
    }
    const current = this.getGoal(goalId);
    const now = new Date().toISOString();
    const attach = this.database.transaction(() => {
      this.database
        .prepare("UPDATE goals SET artifact_identity = ?, updated_at = ? WHERE goal_id = ?")
        .run(identity, now, goalId);
      if (current.artifactIdentity && current.artifactIdentity !== identity) {
        this.database
          .prepare(`
            UPDATE approvals SET status = 'invalidated', decided_at = ?, decision_note = 'Artifact identity changed'
            WHERE goal_id = ? AND status IN ('pending', 'approved')
          `)
          .run(now, goalId);
        this.database
          .prepare(`
            UPDATE release_checks SET result = 'invalidated'
            WHERE goal_id = ? AND artifact_hash != ? AND result = 'pass'
          `)
          .run(goalId, identity);
      }
      this.recordEvent({
        type:
          current.artifactIdentity && current.artifactIdentity !== identity
            ? "artifact.mutated"
            : "artifact.attached",
        summary:
          current.artifactIdentity && current.artifactIdentity !== identity
            ? "Candidate identity changed; prior approvals invalidated"
            : "Candidate identity attached",
        severity: current.artifactIdentity && current.artifactIdentity !== identity ? "warning" : "info",
        agentId: actorAgentId,
        goalId,
        metadata: { previousIdentity: current.artifactIdentity, candidateIdentity: identity },
      });
    });
    attach();
    return this.getGoal(goalId);
  }

  invalidateArtifact(goalId: string, actorAgentId: string, reason: string): GoalSummary {
    const current = this.getGoal(goalId);
    if (!current.artifactIdentity) {
      return current;
    }
    const now = new Date().toISOString();
    const invalidate = this.database.transaction(() => {
      const result = this.database
        .prepare(
          "UPDATE goals SET artifact_identity = NULL, updated_at = ? WHERE goal_id = ? AND artifact_identity = ?",
        )
        .run(now, goalId, current.artifactIdentity);
      if (result.changes !== 1) {
        throw new Error("Artifact identity changed concurrently");
      }
      this.database
        .prepare(`
          UPDATE approvals SET status = 'invalidated', decided_at = ?,
            decision_note = 'Candidate changed before approved action'
          WHERE goal_id = ? AND status IN ('pending', 'approved')
        `)
        .run(now, goalId);
      this.database
        .prepare(`
          UPDATE release_checks SET result = 'invalidated'
          WHERE goal_id = ? AND result = 'pass'
        `)
        .run(goalId);
      this.recordEvent({
        type: "artifact.invalidated",
        summary: "Candidate mutation invalidated its identity, passing gates, and approvals",
        severity: "warning",
        agentId: actorAgentId,
        goalId,
        metadata: {
          previousIdentity: current.artifactIdentity,
          reason: sanitizeText(reason, 300),
        },
      });
    });
    invalidate();
    return this.getGoal(goalId);
  }

  createSession(input: CreateSessionInput): void {
    const now = new Date().toISOString();
    const create = this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO sessions (
            session_id, agent_id, goal_id, state, requested_provider, requested_model, reasoning,
            route_id, model_policy_version, model_decision_json, workspace_id, started_at, last_heartbeat_at
          ) VALUES (?, ?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.sessionId,
          input.agentId,
          input.goalId,
          input.requestedProvider,
          input.requestedModel,
          input.reasoning,
          input.routeId,
          input.modelPolicyVersion,
          JSON.stringify(sanitizeMetadata(input.modelDecision)),
          input.workspaceId,
          now,
          now,
        );
      this.database
        .prepare(`
          UPDATE agents SET current_session_id = ?, current_goal_id = ?, current_workspace_id = ?,
            state = 'queued', last_heartbeat_at = ?, status_reason = 'OMP session configured'
          WHERE agent_id = ? AND archived_at IS NULL
        `)
        .run(input.sessionId, input.goalId, input.workspaceId, now, input.agentId);
      this.recordEvent({
        type: "session.configured",
        summary: `OMP session configured with route ${input.routeId}`,
        agentId: input.agentId,
        goalId: input.goalId,
        sessionId: input.sessionId,
        metadata: {
          model: input.requestedModel,
          provider: input.requestedProvider,
          reasoning: input.reasoning,
        },
      });
    });
    create();
  }

  updateSession(input: {
    sessionId: string;
    state: SessionState;
    processId?: number | null;
    ompSessionId?: string | null;
    effectiveProvider?: string | null;
    effectiveModel?: string | null;
    exitCode?: number | null;
    errorCode?: string | null;
    errorSummary?: string | null;
  }): void {
    const now = new Date().toISOString();
    const terminal = ["exited", "crashed", "disconnected"].includes(input.state);
    const update = this.database.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE sessions SET
            state = @state,
            process_id = COALESCE(@processId, process_id),
            omp_session_id = COALESCE(@ompSessionId, omp_session_id),
            effective_provider = COALESCE(@effectiveProvider, effective_provider),
            effective_model = COALESCE(@effectiveModel, effective_model),
            last_heartbeat_at = @now,
            ended_at = CASE WHEN @terminal = 1 THEN @now ELSE ended_at END,
            exit_code = COALESCE(@exitCode, exit_code),
            error_code = COALESCE(@errorCode, error_code),
            error_summary = COALESCE(@errorSummary, error_summary)
          WHERE session_id = @sessionId
        `)
        .run({
          sessionId: input.sessionId,
          state: input.state,
          processId: input.processId ?? null,
          ompSessionId: input.ompSessionId ?? null,
          effectiveProvider: input.effectiveProvider ?? null,
          effectiveModel: input.effectiveModel ?? null,
          exitCode: input.exitCode ?? null,
          errorCode: input.errorCode ?? null,
          errorSummary: input.errorSummary ? sanitizeText(input.errorSummary, 500) : null,
          now,
          terminal: terminal ? 1 : 0,
        });
      if (result.changes !== 1) {
        throw new Error(`Unknown session: ${input.sessionId}`);
      }
      const session = this.database
        .prepare("SELECT agent_id AS agentId, goal_id AS goalId FROM sessions WHERE session_id = ?")
        .get(input.sessionId) as { agentId: string; goalId: string | null };
      this.database
        .prepare(`
          UPDATE agents SET state = ?, last_heartbeat_at = ?, status_reason = ?,
            current_session_id = CASE WHEN ? = 1 THEN NULL ELSE current_session_id END
          WHERE agent_id = ?
        `)
        .run(
          agentStateForSession(input.state),
          now,
          input.errorSummary ?? `OMP session ${input.state}`,
          terminal ? 1 : 0,
          session.agentId,
        );
      this.recordEvent({
        type: `session.${input.state}`,
        summary: input.errorSummary ?? `OMP session ${input.state}`,
        severity: input.state === "crashed" || input.state === "disconnected" ? "error" : "info",
        agentId: session.agentId,
        goalId: session.goalId,
        sessionId: input.sessionId,
        metadata: { exitCode: input.exitCode ?? null, errorCode: input.errorCode ?? null },
      });
    });
    update();
  }

  createMessage(input: {
    senderAgentId: string;
    recipientAgentId: string;
    goalId: string | null;
    sessionId: string;
    direction: MessageSummary["direction"];
    content: string;
  }): MessageSummary {
    const messageId = identifier("msg");
    const createdAt = new Date().toISOString();
    const content = sanitizeText(input.content, 8_000);
    this.database
      .prepare(`
        INSERT INTO messages (
          message_id, sender_agent_id, recipient_agent_id, goal_id, session_id, direction,
          status, content, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `)
      .run(
        messageId,
        input.senderAgentId,
        input.recipientAgentId,
        input.goalId,
        input.sessionId,
        input.direction,
        content,
        sha256(content),
        createdAt,
      );
    this.recordEvent({
      type: "message.queued",
      summary: `${input.senderAgentId} → ${input.recipientAgentId}`,
      agentId: input.recipientAgentId,
      goalId: input.goalId,
      sessionId: input.sessionId,
      metadata: { messageId, direction: input.direction },
    });
    return {
      messageId,
      senderAgentId: input.senderAgentId,
      recipientAgentId: input.recipientAgentId,
      goalId: input.goalId,
      sessionId: input.sessionId,
      direction: input.direction,
      status: "queued",
      content,
      createdAt,
      deliveredAt: null,
    };
  }

  settleMessage(messageId: string, status: "delivered" | "failed", summary: string): void {
    const now = new Date().toISOString();
    const message = this.database
      .prepare(
        "SELECT recipient_agent_id AS recipientAgentId, goal_id AS goalId, session_id AS sessionId FROM messages WHERE message_id = ?",
      )
      .get(messageId) as { recipientAgentId: string; goalId: string | null; sessionId: string } | undefined;
    if (!message) {
      throw new Error(`Unknown message: ${messageId}`);
    }
    this.database
      .prepare(
        "UPDATE messages SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE message_id = ?",
      )
      .run(status, status, now, messageId);
    this.recordEvent({
      type: `message.${status}`,
      summary,
      severity: status === "failed" ? "error" : "info",
      agentId: message.recipientAgentId,
      goalId: message.goalId,
      sessionId: message.sessionId,
      metadata: { messageId },
    });
  }

  addEvidence(input: {
    goalId: string;
    producerAgentId: string;
    verifierAgentId: string | null;
    evidenceType: string;
    candidateIdentity: string;
    result: EvidenceResult;
    summary: string;
    limitations: string[];
    artifactHash: string;
  }): EvidenceSummary {
    const evidenceId = identifier("evidence");
    const createdAt = new Date().toISOString();
    const evidence: EvidenceSummary = {
      evidenceId,
      goalId: input.goalId,
      producerAgentId: input.producerAgentId,
      verifierAgentId: input.verifierAgentId,
      evidenceType: sanitizeText(input.evidenceType, 100),
      candidateIdentity: input.candidateIdentity,
      result: input.result,
      summary: sanitizeText(input.summary, 2_000),
      limitations: input.limitations.map((item) => sanitizeText(item, 500)),
      artifactHash: input.artifactHash,
      createdAt,
    };
    this.database
      .prepare(`
        INSERT INTO evidence (
          evidence_id, goal_id, producer_agent_id, verifier_agent_id, evidence_type,
          candidate_identity, result, summary, limitations_json, artifact_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        evidence.evidenceId,
        evidence.goalId,
        evidence.producerAgentId,
        evidence.verifierAgentId,
        evidence.evidenceType,
        evidence.candidateIdentity,
        evidence.result,
        evidence.summary,
        JSON.stringify(evidence.limitations),
        evidence.artifactHash,
        evidence.createdAt,
      );
    this.recordEvent({
      type: "evidence.recorded",
      summary: `${evidence.evidenceType}: ${evidence.result}`,
      severity: evidence.result === "fail" ? "error" : evidence.result === "unverified" ? "warning" : "info",
      agentId: evidence.producerAgentId,
      goalId: evidence.goalId,
      metadata: { evidenceId, result: evidence.result, candidateIdentity: evidence.candidateIdentity },
    });
    return evidence;
  }

  reconcileInterruptedState(
    staleSessionMs = 60_000,
    probeProcess: (processId: number) => "live" | "dead" | "unknown" = probeProcessState,
  ): {
    disconnectedSessions: number;
    blockedGoals: number;
    liveProcesses: number;
    deadProcesses: number;
    staleProcesses: number;
    unknownProcesses: number;
  } {
    const now = new Date().toISOString();
    let disconnectedSessions = 0;
    let blockedGoals = 0;
    const processCounts = { live: 0, dead: 0, stale: 0, unknown: 0 };
    const reconcile = this.database.transaction(() => {
      const activeSessions = this.database
        .prepare(`
          SELECT session_id AS sessionId, agent_id AS agentId, goal_id AS goalId,
            process_id AS processId, last_heartbeat_at AS lastHeartbeatAt
          FROM sessions WHERE state IN ('configured', 'starting', 'ready', 'streaming', 'idle', 'stopping')
        `)
        .all() as Array<{
        sessionId: string;
        agentId: string;
        goalId: string | null;
        processId: number | null;
        lastHeartbeatAt: string;
      }>;
      for (const session of activeSessions) {
        const probed =
          session.processId === null || session.processId <= 0 ? "unknown" : probeProcess(session.processId);
        const processState =
          probed === "live" &&
          Date.now() - Date.parse(session.lastHeartbeatAt) > Math.max(1_000, staleSessionMs)
            ? "stale"
            : probed;
        processCounts[processState] += 1;
        const retryBlocked =
          processState === "live" || processState === "stale" || processState === "unknown";
        const summary =
          processState === "live"
            ? "Controller restarted while the prior OMP process was still live; retry is blocked"
            : processState === "stale"
              ? "Controller restarted with a stale prior OMP process; retry is blocked"
              : processState === "dead"
                ? "Controller restarted after the prior OMP process exited; explicit retry is required"
                : "Controller restarted and prior OMP process state is unknown; retry is blocked";
        this.database
          .prepare(`
            UPDATE sessions SET state = 'disconnected', ended_at = ?, last_heartbeat_at = ?,
              error_code = ?, error_summary = ?
            WHERE session_id = ?
          `)
          .run(now, now, `restart_process_${processState}`, summary, session.sessionId);
        this.database
          .prepare(`
            UPDATE agents SET state = 'disconnected', current_session_id = NULL,
              status_reason = ?, last_heartbeat_at = ?
            WHERE agent_id = ?
          `)
          .run(summary, now, session.agentId);
        disconnectedSessions += 1;
        if (session.goalId) {
          const result = this.database
            .prepare(`
              UPDATE goals SET state = 'blocked', updated_at = ?
              WHERE goal_id = ? AND state IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'verifying')
            `)
            .run(now, session.goalId);
          blockedGoals += result.changes;
        }
        this.recordEvent({
          type: "session.disconnected",
          summary,
          severity: retryBlocked ? "error" : "warning",
          agentId: session.agentId,
          goalId: session.goalId,
          sessionId: session.sessionId,
          metadata: {
            recovery: retryBlocked ? "process_termination_required" : "explicit_restart_required",
            processState,
            processId: session.processId,
          },
        });
      }
    });
    reconcile();
    return {
      disconnectedSessions,
      blockedGoals,
      liveProcesses: processCounts.live,
      deadProcesses: processCounts.dead,
      staleProcesses: processCounts.stale,
      unknownProcesses: processCounts.unknown,
    };
  }

  createImprovementReview(input: {
    title: string;
    hypothesis: string;
    baseline: string;
    proposedChange: string;
    safetyMetric: string;
    evaluationPlan: string;
    sourceEventIds: string[];
    authorizedBy: string;
  }): ImprovementReviewSummary {
    const reviewId = identifier("improvement");
    const createdAt = new Date().toISOString();
    const title = sanitizeText(input.title, 160);
    const hypothesis = sanitizeText(input.hypothesis, 2_000);
    const baseline = sanitizeText(input.baseline, 2_000);
    const proposedChange = sanitizeText(input.proposedChange, 4_000);
    const safetyMetric = sanitizeText(input.safetyMetric, 1_000);
    const evaluationPlan = sanitizeText(input.evaluationPlan, 2_000);
    const sourceEventIds = [...new Set(input.sourceEventIds)].slice(0, 50);
    const artifactIdentity = sha256(
      canonicalJson({
        title,
        hypothesis,
        baseline,
        proposedChange,
        safetyMetric,
        evaluationPlan,
        sourceEventIds,
      }),
    );
    this.database
      .prepare(`
        INSERT INTO improvement_reviews (
          review_id, title, hypothesis, baseline, proposed_change, safety_metric,
          evaluation_plan, state, result_summary, limitations_json,
          source_event_ids_json, artifact_identity, authorized_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, '[]', ?, ?, ?, ?, ?)
      `)
      .run(
        reviewId,
        title,
        hypothesis,
        baseline,
        proposedChange,
        safetyMetric,
        evaluationPlan,
        JSON.stringify(sourceEventIds),
        artifactIdentity,
        input.authorizedBy,
        createdAt,
        createdAt,
      );
    this.recordEvent({
      type: "improvement.proposed",
      summary: title,
      agentId: input.authorizedBy,
      metadata: { reviewId, artifactIdentity, sourceEventIds },
    });
    return this.getImprovementReview(reviewId);
  }

  transitionImprovementReview(input: {
    reviewId: string;
    state: ImprovementState;
    resultSummary: string;
    limitations: string[];
    authorizedBy: string;
  }): ImprovementReviewSummary {
    const current = this.getImprovementReview(input.reviewId);
    const allowed: Readonly<Record<ImprovementState, readonly ImprovementState[]>> = {
      proposed: ["sandboxed", "rejected"],
      sandboxed: ["evaluated", "rejected"],
      evaluated: ["canary", "rejected"],
      canary: ["observing", "rolled_back"],
      observing: ["adopted", "rolled_back"],
      adopted: ["rolled_back"],
      rejected: [],
      rolled_back: [],
    };
    if (!allowed[current.state].includes(input.state)) {
      throw new Error(`Improvement review cannot transition from ${current.state} to ${input.state}`);
    }
    const resultSummary = sanitizeText(input.resultSummary, 2_000);
    const limitations = input.limitations.map((item) => sanitizeText(item, 500)).slice(0, 20);
    if (!resultSummary) {
      throw new Error("Improvement transition requires an observable result summary");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE improvement_reviews
        SET state = ?, result_summary = ?, limitations_json = ?, updated_at = ?
        WHERE review_id = ?
      `)
      .run(input.state, resultSummary, JSON.stringify(limitations), now, input.reviewId);
    this.recordEvent({
      type: `improvement.${input.state}`,
      summary: resultSummary,
      agentId: input.authorizedBy,
      metadata: {
        reviewId: input.reviewId,
        artifactIdentity: current.artifactIdentity,
        previousState: current.state,
        limitations,
      },
    });
    return this.getImprovementReview(input.reviewId);
  }

  getImprovementReview(reviewId: string): ImprovementReviewSummary {
    const review = this.listImprovementReviews().find((item) => item.reviewId === reviewId);
    if (!review) {
      throw new Error(`Unknown improvement review: ${reviewId}`);
    }
    return review;
  }
  snapshot(metadata: ControllerSnapshotMetadata): DashboardSnapshot {
    const agents = this.listAgents();
    const goals = this.listGoals();
    const approvals = this.listApprovals();
    const hierarchyById = new Map<string, AgentNode>();
    for (const agent of agents) {
      hierarchyById.set(agent.agentId, { ...agent, children: [] });
    }
    const hierarchy: AgentNode[] = [];
    for (const agent of agents) {
      const node = hierarchyById.get(agent.agentId);
      if (!node) {
        continue;
      }
      if (agent.parentAgentId) {
        const parent = hierarchyById.get(agent.parentAgentId);
        if (parent) {
          parent.children.push(node);
          continue;
        }
      }
      hierarchy.push(node);
    }

    return {
      generatedAt: new Date().toISOString(),
      controller: { ...metadata, safetyMode: "local_only" },
      counts: {
        activeAgents: agents.filter((agent) => ACTIVE_AGENT_STATES[agent.state]).length,
        runningGoals: goals.filter((goal) => ["queued", "running", "verifying"].includes(goal.state)).length,
        waitingApprovals: approvals.filter((approval) => approval.status === "pending").length,
        blockedItems:
          agents.filter((agent) => ["blocked", "failed", "disconnected"].includes(agent.state)).length +
          goals.filter((goal) => ["blocked", "failed"].includes(goal.state)).length,
      },
      hierarchy,
      agents,
      goals,
      events: this.listEvents(200),
      messages: this.listMessages(100),
      approvals,
      evidence: this.listEvidence(100),
      checkDefinitions: this.listCheckDefinitions(500),
      checkRuns: this.listCheckRuns(200),
      releaseGates: this.listReleaseGates(100),
      leases: this.listLeases(),
      workspaces: this.listWorkspaces(),
      improvements: this.listImprovementReviews(),
    };
  }

  getAgentDetail(agentId: string): AgentDetail {
    const agent = this.listAgents().find((candidate) => candidate.agentId === agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const ownedGoalIds = new Set(
      this.listGoals()
        .filter((goal) => goal.ownerAgentId === agentId)
        .map((goal) => goal.goalId),
    );
    const ownedWorkspaceIds = new Set(
      this.listWorkspaces()
        .filter((workspace) => ownedGoalIds.has(workspace.goalId))
        .map((workspace) => workspace.workspaceId),
    );
    return {
      agent,
      role: getRoleContract(agent.roleId),
      goal: agent.currentGoalId ? this.getGoal(agent.currentGoalId) : null,
      workspace: agent.workspaceId
        ? (this.listWorkspaces().find((item) => item.workspaceId === agent.workspaceId) ?? null)
        : null,
      workspaceInspection: null,
      sessions: this.listSessions(100).filter((session) => session.agentId === agentId),
      checkDefinitions: this.listCheckDefinitions(500).filter((check) =>
        ownedWorkspaceIds.has(check.workspaceId),
      ),
      checkRuns: this.listCheckRuns(200).filter(
        (run) => run.agentId === agentId || ownedGoalIds.has(run.goalId),
      ),
      releaseGates: this.listReleaseGates(100).filter(
        (gate) => gate.recordedByAgentId === agentId || ownedGoalIds.has(gate.goalId),
      ),
      messages: this.listMessages(100).filter(
        (message) => message.senderAgentId === agentId || message.recipientAgentId === agentId,
      ),
      events: this.listEvents(200).filter((event) => event.agentId === agentId),
      evidence: this.listEvidence(100).filter(
        (item) => item.producerAgentId === agentId || item.verifierAgentId === agentId,
      ),
      leases: this.listLeases().filter((lease) => lease.agentId === agentId),
    };
  }

  listAgents(): AgentSummary[] {
    const rows = this.database
      .prepare(`
        SELECT
          a.agent_id AS agentId, a.display_name AS displayName, a.role_id AS roleId,
          r.display_name AS roleName, r.kind, a.parent_agent_id AS parentAgentId, a.state,
          a.current_goal_id AS currentGoalId, g.title AS currentGoalTitle,
          a.current_session_id AS sessionId, s.state AS sessionState,
          s.effective_model AS model, s.reasoning, a.current_workspace_id AS workspaceId,
          a.last_heartbeat_at AS lastHeartbeatAt, a.status_reason AS statusReason,
          a.temporary, a.archived_at AS archivedAt
        FROM agents a
        JOIN roles r ON r.role_id = a.role_id
        LEFT JOIN goals g ON g.goal_id = a.current_goal_id
        LEFT JOIN sessions s ON s.session_id = a.current_session_id
        WHERE a.archived_at IS NULL
        ORDER BY a.created_at, a.agent_id
      `)
      .all() as AgentRow[];
    return rows.map((row) => ({
      ...row,
      roleWriteScope: getRoleContract(row.roleId).writeScope,
      temporary: row.temporary === 1,
    }));
  }

  listGoals(): GoalSummary[] {
    const rows = this.database
      .prepare(`
        SELECT
          goal_id AS goalId, parent_goal_id AS parentGoalId, owner_agent_id AS ownerAgentId,
          title, description, acceptance_criteria_json AS acceptanceCriteriaJson,
          required_checks_json AS requiredChecksJson, state, risk_level AS riskLevel,
          data_class AS dataClass, write_scope AS writeScope,
          external_effects_json AS externalEffectsJson, authorized_by AS authorizedBy,
          artifact_identity AS artifactIdentity, created_at AS createdAt, updated_at AS updatedAt
        FROM goals ORDER BY created_at DESC
      `)
      .all() as GoalRow[];
    return rows.map(goalFromRow);
  }

  listEvents(limit: number): EventSummary[] {
    const rows = this.database
      .prepare(`
        SELECT sequence, event_id AS eventId, occurred_at AS occurredAt, agent_id AS agentId,
          goal_id AS goalId, session_id AS sessionId, type, severity, summary,
          metadata_json AS metadataJson
        FROM events ORDER BY sequence DESC LIMIT ?
      `)
      .all(limit) as EventRow[];
    return rows.map((row) => {
      const { metadataJson, ...event } = row;
      return eventFromMetadata(event, parseMetadata(metadataJson));
    });
  }

  listMessages(limit: number): MessageSummary[] {
    return this.database
      .prepare(`
        SELECT message_id AS messageId, sender_agent_id AS senderAgentId,
          recipient_agent_id AS recipientAgentId, goal_id AS goalId, session_id AS sessionId,
          direction, status, content, created_at AS createdAt, delivered_at AS deliveredAt
        FROM messages ORDER BY created_at DESC LIMIT ?
      `)
      .all(limit) as MessageSummary[];
  }

  getGoalOutput(goalId: string): {
    messageId: string;
    content: string;
    artifactIdentity: string;
    createdAt: string;
  } | null {
    const goal = this.getGoal(goalId);
    if (!goal.artifactIdentity) {
      return null;
    }
    return (
      (this.database
        .prepare(`
          SELECT message_id AS messageId, content, content_hash AS artifactIdentity,
            created_at AS createdAt
          FROM messages
          WHERE goal_id = ? AND sender_agent_id = ? AND direction = 'agent_to_owner'
            AND status = 'delivered' AND content_hash = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `)
        .get(goalId, goal.ownerAgentId, goal.artifactIdentity) as
        | {
            messageId: string;
            content: string;
            artifactIdentity: string;
            createdAt: string;
          }
        | undefined) ?? null
    );
  }

  listImprovementReviews(): ImprovementReviewSummary[] {
    const rows = this.database
      .prepare(`
        SELECT review_id AS reviewId, title, hypothesis, baseline,
          proposed_change AS proposedChange, safety_metric AS safetyMetric,
          evaluation_plan AS evaluationPlan, state, result_summary AS resultSummary,
          limitations_json AS limitationsJson, source_event_ids_json AS sourceEventIdsJson,
          artifact_identity AS artifactIdentity, authorized_by AS authorizedBy,
          created_at AS createdAt, updated_at AS updatedAt
        FROM improvement_reviews ORDER BY created_at DESC, rowid DESC
      `)
      .all() as Array<
      Omit<ImprovementReviewSummary, "limitations" | "sourceEventIds"> & {
        limitationsJson: string;
        sourceEventIdsJson: string;
      }
    >;
    return rows.map(({ limitationsJson, sourceEventIdsJson, ...review }) => ({
      ...review,
      limitations: parseStringArray(limitationsJson),
      sourceEventIds: parseStringArray(sourceEventIdsJson),
    }));
  }

  listApprovals(): ApprovalSummary[] {
    return this.database
      .prepare(`
        SELECT approval_id AS approvalId, goal_id AS goalId,
          requested_by_agent_id AS requestedByAgentId, action, target,
          artifact_hash AS artifactHash, request_hash AS requestHash, risk_level AS riskLevel,
          expires_at AS expiresAt, status, decided_by AS decidedBy, decision_note AS decisionNote,
          created_at AS createdAt, decided_at AS decidedAt
        FROM approvals ORDER BY created_at DESC
      `)
      .all() as ApprovalSummary[];
  }

  listEvidence(limit: number): EvidenceSummary[] {
    const rows = this.database
      .prepare(`
        SELECT evidence_id AS evidenceId, goal_id AS goalId,
          producer_agent_id AS producerAgentId, verifier_agent_id AS verifierAgentId,
          evidence_type AS evidenceType, candidate_identity AS candidateIdentity, result,
          summary, limitations_json AS limitationsJson, artifact_hash AS artifactHash,
          created_at AS createdAt
        FROM evidence ORDER BY created_at DESC LIMIT ?
      `)
      .all(limit) as EvidenceRow[];
    return rows.map((row) => ({
      evidenceId: row.evidenceId,
      goalId: row.goalId,
      producerAgentId: row.producerAgentId,
      verifierAgentId: row.verifierAgentId,
      evidenceType: row.evidenceType,
      candidateIdentity: row.candidateIdentity,
      result: row.result,
      summary: row.summary,
      limitations: parseStringArray(row.limitationsJson),
      artifactHash: row.artifactHash,
      createdAt: row.createdAt,
    }));
  }

  listSessions(limit: number): SessionSummary[] {
    return this.database
      .prepare(`
        SELECT session_id AS sessionId, agent_id AS agentId, goal_id AS goalId,
          omp_session_id AS ompSessionId, process_id AS processId, state,
          requested_provider AS requestedProvider, requested_model AS requestedModel,
          effective_provider AS effectiveProvider, effective_model AS effectiveModel,
          reasoning, route_id AS routeId, model_policy_version AS modelPolicyVersion,
          workspace_id AS workspaceId, started_at AS startedAt,
          last_heartbeat_at AS lastHeartbeatAt, ended_at AS endedAt, exit_code AS exitCode,
          error_code AS errorCode, error_summary AS errorSummary
        FROM sessions ORDER BY started_at DESC LIMIT ?
      `)
      .all(limit) as SessionSummary[];
  }

  listCheckDefinitions(limit: number): CheckDefinitionSummary[] {
    const rows = this.database
      .prepare(`
        SELECT check_id AS checkId, workspace_id AS workspaceId, label, executable,
          arguments_json AS argumentsJson, relative_cwd AS relativeCwd,
          timeout_ms AS timeoutMs, created_at AS createdAt
        FROM check_definitions ORDER BY created_at DESC LIMIT ?
      `)
      .all(limit) as CheckDefinitionRow[];
    return rows.map((row) => ({
      ...row,
      arguments: parseStringArray(row.argumentsJson),
    }));
  }

  listCheckRuns(limit: number): CheckRunSummary[] {
    const rows = this.database
      .prepare(`
        SELECT cr.check_run_id AS checkRunId, cr.check_id AS checkId,
          cd.workspace_id AS workspaceId, cd.label, cd.executable,
          cd.arguments_json AS argumentsJson, cd.relative_cwd AS relativeCwd,
          cr.goal_id AS goalId, cr.agent_id AS agentId,
          cr.candidate_identity AS candidateIdentity, cr.result,
          cr.exit_code AS exitCode, cr.output_summary AS outputSummary,
          cr.started_at AS startedAt, cr.ended_at AS endedAt
        FROM check_runs cr
        JOIN check_definitions cd ON cd.check_id = cr.check_id
        ORDER BY cr.ended_at DESC, cr.rowid DESC LIMIT ?
      `)
      .all(limit) as CheckRunRow[];
    return rows.map((row) => ({
      ...row,
      arguments: parseStringArray(row.argumentsJson),
    }));
  }

  listReleaseGates(limit: number): ReleaseGateSummary[] {
    return this.database
      .prepare(`
        SELECT release_check_id AS releaseCheckId, goal_id AS goalId, gate, result,
          evidence_id AS evidenceId, artifact_hash AS artifactHash,
          recorded_by_agent_id AS recordedByAgentId, created_at AS createdAt
        FROM release_checks ORDER BY created_at DESC, rowid DESC LIMIT ?
      `)
      .all(limit) as ReleaseGateSummary[];
  }

  listLeases(): TerritoryLeaseSummary[] {
    return this.database
      .prepare(`
        SELECT lease_id AS leaseId, goal_id AS goalId, agent_id AS agentId,
          workspace_id AS workspaceId, normalized_path AS path, mode,
          acquired_at AS acquiredAt, expires_at AS expiresAt, released_at AS releasedAt
        FROM territory_leases ORDER BY acquired_at DESC
      `)
      .all() as TerritoryLeaseSummary[];
  }

  listWorkspaces(): WorkspaceSummary[] {
    return this.database
      .prepare(`
        SELECT workspace_id AS workspaceId, goal_id AS goalId, agent_id AS agentId,
          integration_owner_agent_id AS integrationOwnerAgentId,
          repository_root AS repositoryRoot, worktree_path AS worktreePath,
          base_revision AS baseRevision, current_revision AS currentRevision,
          mode, state, created_at AS createdAt, released_at AS releasedAt
        FROM workspaces ORDER BY created_at DESC
      `)
      .all() as WorkspaceSummary[];
  }
}

interface AgentRow extends Omit<AgentSummary, "roleWriteScope" | "temporary"> {
  temporary: number;
}
interface CheckDefinitionRow extends Omit<CheckDefinitionSummary, "arguments"> {
  argumentsJson: string;
}
interface CheckRunRow extends Omit<CheckRunSummary, "arguments"> {
  argumentsJson: string;
}

interface GoalRow {
  goalId: string;
  parentGoalId: string | null;
  ownerAgentId: string;
  title: string;
  description: string;
  acceptanceCriteriaJson: string;
  requiredChecksJson: string;
  state: GoalState;
  riskLevel: RiskLevel;
  dataClass: DataClass;
  writeScope: GoalSummary["writeScope"];
  externalEffectsJson: string;
  authorizedBy: string | null;
  artifactIdentity: string | null;
  createdAt: string;
  updatedAt: string;
}

type EventCore = Pick<
  EventSummary,
  "eventId" | "sequence" | "occurredAt" | "agentId" | "goalId" | "sessionId" | "type" | "severity" | "summary"
>;

interface EventRow extends EventCore {
  metadataJson: string;
}

interface EvidenceRow extends Omit<EvidenceSummary, "limitations"> {
  limitationsJson: string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function eventFromMetadata(event: EventCore, metadata: Record<string, unknown>): EventSummary {
  return {
    ...event,
    ompSessionId: stringOrNull(metadata.ompSessionId),
    parentGoalId: stringOrNull(metadata.parentGoalId),
    statusBefore: stringOrNull(metadata.statusBefore),
    statusAfter: stringOrNull(metadata.statusAfter),
    toolName: stringOrNull(metadata.toolName),
    workspaceId: stringOrNull(metadata.workspaceId),
    filePaths: stringArray(metadata.filePaths),
    commandSummary: stringOrNull(metadata.commandSummary),
    evidenceRefs: stringArray(metadata.evidenceRefs),
    approvalRequestId: stringOrNull(metadata.approvalRequestId),
    redactionApplied: metadata.redactionApplied === true,
    sourceEventVersion: 1,
    metadata,
  };
}

function goalFromRow(row: GoalRow): GoalSummary {
  return {
    goalId: row.goalId,
    parentGoalId: row.parentGoalId,
    ownerAgentId: row.ownerAgentId,
    title: row.title,
    description: row.description,
    acceptanceCriteria: parseStringArray(row.acceptanceCriteriaJson),
    requiredChecks: parseStringArray(row.requiredChecksJson),
    state: row.state,
    riskLevel: row.riskLevel,
    dataClass: row.dataClass,
    writeScope: row.writeScope,
    externalEffects: parseStringArray(row.externalEffectsJson),
    authorizedBy: row.authorizedBy,
    artifactIdentity: row.artifactIdentity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function agentStateForGoal(state: GoalState): AgentState {
  const mapping: Readonly<Record<GoalState, AgentState>> = {
    draft: "idle",
    queued: "queued",
    running: "running",
    waiting_input: "waiting_input",
    waiting_approval: "waiting_approval",
    verifying: "verifying",
    blocked: "blocked",
    failed: "failed",
    cancelled: "cancelled",
    rolled_back: "complete",
    complete: "complete",
  };
  return mapping[state];
}

function agentStateForSession(state: SessionState): AgentState {
  const mapping: Readonly<Record<SessionState, AgentState>> = {
    configured: "queued",
    starting: "queued",
    ready: "idle",
    streaming: "running",
    idle: "idle",
    stopping: "paused",
    exited: "idle",
    crashed: "failed",
    disconnected: "disconnected",
  };
  return mapping[state];
}

function probeProcessState(processId: number): "live" | "dead" | "unknown" {
  try {
    process.kill(processId, 0);
    return "live";
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      return "dead";
    }
    return "unknown";
  }
}

export function approvalRequestHash(input: {
  goalId: string;
  requestedByAgentId: string;
  action: string;
  target: string;
  artifactHash: string;
  riskLevel: RiskLevel;
  expiresAt: string;
}): string {
  return sha256(canonicalJson(input));
}

export function approvalStatusIsTerminal(status: ApprovalStatus): boolean {
  return status !== "pending";
}
