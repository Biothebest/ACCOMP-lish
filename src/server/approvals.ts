import { randomUUID } from "node:crypto";
import type { ApprovalSummary, EvidenceResult, RiskLevel } from "../shared/contracts.js";
import { getRoleContract } from "./roles.js";
import { sanitizeText } from "./security.js";
import { approvalRequestHash, type ControlStore } from "./store.js";

export type ReleaseDecision =
  | { ready: true; artifactHash: string; approvalId: string }
  | { ready: false; code: string; missing: string[] };

export class ApprovalService {
  constructor(
    private readonly store: ControlStore,
    private readonly ownerAgentId: string,
    private readonly defaultTtlMs: number,
  ) {}

  request(input: {
    goalId: string;
    requestedByAgentId: string;
    action: string;
    target: string;
    artifactHash: string;
    riskLevel: RiskLevel;
    ttlMs?: number;
  }): ApprovalSummary {
    if (input.requestedByAgentId === this.ownerAgentId) {
      throw new Error("Owner actions do not create self-addressed agent approval requests");
    }
    const goal = this.store.getGoal(input.goalId);
    if (!goal.artifactIdentity || goal.artifactIdentity !== input.artifactHash) {
      throw new Error("Approval request must bind to the goal's current immutable artifact identity");
    }
    if (goal.ownerAgentId !== input.requestedByAgentId) {
      throw new Error("Approval requester must own the exact bounded goal");
    }
    if (input.riskLevel !== goal.riskLevel) {
      throw new Error("Approval risk must exactly match the bounded goal risk");
    }
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) {
      throw new Error("Approval TTL must be from one minute through one day");
    }
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const action = sanitizeText(input.action, 100);
    const target = sanitizeText(input.target, 500);
    const requestHash = approvalRequestHash({
      goalId: input.goalId,
      requestedByAgentId: input.requestedByAgentId,
      action,
      target,
      artifactHash: input.artifactHash,
      riskLevel: input.riskLevel,
      expiresAt,
    });
    const approvalId = `approval-${randomUUID()}`;
    this.store.database
      .prepare(`
        INSERT INTO approvals (
          approval_id, goal_id, requested_by_agent_id, action, target, artifact_hash,
          request_hash, risk_level, expires_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(
        approvalId,
        input.goalId,
        input.requestedByAgentId,
        action,
        target,
        input.artifactHash,
        requestHash,
        input.riskLevel,
        expiresAt,
        createdAt,
      );
    this.store.recordEvent({
      type: "approval.requested",
      summary: `${action} approval requested for exact artifact ${input.artifactHash.slice(0, 12)}`,
      severity: "warning",
      agentId: input.requestedByAgentId,
      goalId: input.goalId,
      metadata: { approvalId, requestHash, target, expiresAt },
    });
    return this.get(approvalId);
  }

  decide(input: {
    approvalId: string;
    decidedBy: string;
    decision: "approved" | "rejected";
    note: string;
  }): ApprovalSummary {
    if (input.decidedBy !== this.ownerAgentId) {
      throw new Error("Only the configured human owner may decide consequential approvals");
    }
    const approval = this.get(input.approvalId);
    if (approval.status !== "pending") {
      throw new Error(`Approval is already ${approval.status}`);
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      this.store.database
        .prepare(
          "UPDATE approvals SET status = 'expired', decided_at = ? WHERE approval_id = ? AND status = 'pending'",
        )
        .run(new Date().toISOString(), input.approvalId);
      throw new Error("Approval request expired before decision");
    }
    const goal = this.store.getGoal(approval.goalId);
    if (goal.artifactIdentity !== approval.artifactHash) {
      this.store.database
        .prepare(
          "UPDATE approvals SET status = 'invalidated', decided_at = ?, decision_note = 'Artifact identity changed' WHERE approval_id = ?",
        )
        .run(new Date().toISOString(), approval.approvalId);
      throw new Error("Approval request was invalidated by artifact mutation");
    }

    const decidedAt = new Date().toISOString();
    const result = this.store.database
      .prepare(`
        UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?
        WHERE approval_id = ? AND status = 'pending' AND artifact_hash = ?
      `)
      .run(
        input.decision,
        input.decidedBy,
        sanitizeText(input.note, 1_000),
        decidedAt,
        input.approvalId,
        goal.artifactIdentity,
      );
    if (result.changes !== 1) {
      throw new Error("Approval changed concurrently");
    }
    this.store.recordEvent({
      type: `approval.${input.decision}`,
      summary: `${approval.action} ${input.decision} by human owner`,
      severity: input.decision === "rejected" ? "warning" : "info",
      agentId: input.decidedBy,
      goalId: approval.goalId,
      metadata: { approvalId: approval.approvalId, requestHash: approval.requestHash },
    });
    return this.get(input.approvalId);
  }

  expireAuthorizations(): number {
    const now = new Date().toISOString();
    const candidates = this.store
      .listApprovals()
      .filter((approval) => ["pending", "approved"].includes(approval.status) && approval.expiresAt <= now);
    let expired = 0;
    for (const approval of candidates) {
      const result = this.store.database
        .prepare(`
          UPDATE approvals SET status = 'expired', decided_at = COALESCE(decided_at, ?)
          WHERE approval_id = ? AND status = ? AND expires_at <= ?
        `)
        .run(now, approval.approvalId, approval.status, now);
      if (result.changes !== 1) {
        continue;
      }
      expired += 1;
      this.store.recordEvent({
        type: "approval.expired",
        summary: `${approval.action} approval expired`,
        severity: approval.status === "approved" ? "warning" : "info",
        agentId: approval.requestedByAgentId,
        goalId: approval.goalId,
        metadata: { approvalId: approval.approvalId, previousStatus: approval.status },
      });
    }
    return expired;
  }

  recordGate(input: {
    goalId: string;
    gate: "quality" | "security";
    result: EvidenceResult;
    evidenceId: string;
    artifactHash: string;
    recordedByAgentId: string;
  }): void {
    const actor = this.store.listAgents().find((agent) => agent.agentId === input.recordedByAgentId);
    if (!actor) {
      throw new Error(`Unknown gate actor: ${input.recordedByAgentId}`);
    }
    const requiredRole = input.gate === "security" ? "ROLE-SECURITY-DIRECTOR" : "ROLE-QUALITY-DIRECTOR";
    if (actor.roleId !== requiredRole) {
      throw new Error(`${input.gate} gate must be recorded by ${requiredRole}`);
    }
    const evidence = this.store.listEvidence(1_000).find((item) => item.evidenceId === input.evidenceId);
    if (!evidence || evidence.goalId !== input.goalId || evidence.artifactHash !== input.artifactHash) {
      throw new Error("Gate evidence does not match goal and artifact identity");
    }
    if (
      evidence.verifierAgentId !== input.recordedByAgentId ||
      !this.verifierIsIndependent(input.recordedByAgentId, evidence.producerAgentId)
    ) {
      throw new Error("Gate evidence was not independently produced by the required verifier");
    }
    if (evidence.result !== input.result) {
      throw new Error("Gate result must exactly match the referenced evidence result");
    }
    const goal = this.store.getGoal(input.goalId);
    if (goal.artifactIdentity !== input.artifactHash) {
      throw new Error("Gate candidate does not match the goal's current artifact identity");
    }
    const releaseResult = input.result === "pass" ? "pass" : "fail";
    this.store.database
      .prepare(`
        INSERT INTO release_checks (
          release_check_id, goal_id, gate, result, evidence_id, artifact_hash,
          recorded_by_agent_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        `release-check-${randomUUID()}`,
        input.goalId,
        input.gate,
        releaseResult,
        input.evidenceId,
        input.artifactHash,
        input.recordedByAgentId,
        new Date().toISOString(),
      );
    this.store.recordEvent({
      type: `release_gate.${input.gate}.${releaseResult}`,
      summary: `${input.gate} gate ${releaseResult}`,
      severity: releaseResult === "fail" ? "error" : "info",
      agentId: input.recordedByAgentId,
      goalId: input.goalId,
      metadata: { evidenceId: input.evidenceId, artifactHash: input.artifactHash },
    });
  }

  evaluateRelease(goalId: string, artifactHash: string): ReleaseDecision {
    this.expireAuthorizations();
    const goal = this.store.getGoal(goalId);
    if (goal.artifactIdentity !== artifactHash) {
      return { ready: false, code: "artifact_identity_mismatch", missing: ["artifact_identity"] };
    }
    const missing: string[] = [];
    const gates = this.store.database
      .prepare(`
        SELECT gate, result FROM release_checks
        WHERE goal_id = ? AND artifact_hash = ?
        ORDER BY created_at DESC, rowid DESC
      `)
      .all(goalId, artifactHash) as Array<{ gate: string; result: string }>;
    if (gates.some((gate) => gate.gate === "security" && gate.result === "fail")) {
      return { ready: false, code: "security_gate_failed", missing: ["new_security_candidate"] };
    }
    if (gates.some((gate) => gate.gate === "quality" && gate.result === "fail")) {
      return { ready: false, code: "quality_gate_failed", missing: ["new_quality_candidate"] };
    }
    const latestGate: Record<string, string> = {};
    for (const gate of gates) {
      latestGate[gate.gate] ??= gate.result;
    }
    if (latestGate.security !== "pass") {
      missing.push("security_pass");
    }
    if (latestGate.quality !== "pass") {
      missing.push("quality_pass");
    }
    if (goal.state !== "complete") {
      missing.push("goal_completion");
    }
    const checkRuns = this.store
      .listCheckRuns(1_000)
      .filter((run) => run.goalId === goalId && run.candidateIdentity === artifactHash);
    for (const requiredCheck of goal.requiredChecks) {
      if (checkRuns.find((run) => run.label === requiredCheck)?.result !== "pass") {
        missing.push(`check:${requiredCheck}`);
      }
    }
    const approval = this.store
      .listApprovals()
      .find(
        (item) =>
          item.goalId === goalId &&
          item.artifactHash === artifactHash &&
          item.status === "approved" &&
          Date.parse(item.expiresAt) > Date.now() &&
          ["release", "deployment"].includes(item.action),
      );
    if (!approval) {
      missing.push("owner_artifact_approval");
    }
    if (missing.length > 0 || !approval) {
      return { ready: false, code: "release_blocked", missing };
    }
    return { ready: true, artifactHash, approvalId: approval.approvalId };
  }

  get(approvalId: string): ApprovalSummary {
    const approval = this.store.listApprovals().find((candidate) => candidate.approvalId === approvalId);
    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`);
    }
    return approval;
  }

  verifierIsIndependent(verifierAgentId: string, producerAgentId: string): boolean {
    const agents = this.store.listAgents();
    const verifierAgent = agents.find((agent) => agent.agentId === verifierAgentId);
    const producerAgent = agents.find((agent) => agent.agentId === producerAgentId);
    if (!verifierAgent || !producerAgent || verifierAgent.agentId === producerAgent.agentId) {
      return false;
    }
    const verifierRole = getRoleContract(verifierAgent.roleId);
    return (
      verifierRole.kind === "verifier" && verifierRole.independentFromRoleIds.includes(producerAgent.roleId)
    );
  }
}
