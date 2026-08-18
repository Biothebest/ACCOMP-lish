export const AGENT_STATES = [
  "idle",
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "verifying",
  "blocked",
  "failed",
  "complete",
  "disconnected",
  "paused",
  "cancelled",
] as const;

export const GOAL_STATES = [
  "draft",
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "verifying",
  "blocked",
  "failed",
  "cancelled",
  "rolled_back",
  "complete",
] as const;

export const SESSION_STATES = [
  "configured",
  "starting",
  "ready",
  "streaming",
  "idle",
  "stopping",
  "exited",
  "crashed",
  "disconnected",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type GoalState = (typeof GOAL_STATES)[number];
export type SessionState = (typeof SESSION_STATES)[number];
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type DataClass = "public" | "internal" | "confidential" | "privileged";
export type WorkspaceMode = "read" | "write";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated";
export type EvidenceResult = "pass" | "fail" | "unverified";
export type ImprovementState =
  | "proposed"
  | "sandboxed"
  | "evaluated"
  | "canary"
  | "observing"
  | "adopted"
  | "rejected"
  | "rolled_back";

export interface ModelRoute {
  routeId: string;
  model: string;
  provider: string;
  reasoning: "low" | "medium" | "high" | "xhigh" | "max";
  fallback: readonly string[];
}

export interface RoleContract {
  roleId: string;
  displayName: string;
  kind: "human" | "orchestrator" | "director" | "specialist" | "verifier";
  reportsToRoleId: string | null;
  mission: string;
  owns: readonly string[];
  inputs: readonly string[];
  outputs: readonly string[];
  mayDelegateTo: readonly string[];
  mayWriteTo: readonly string[];
  approvalRequired: readonly string[];
  definitionOfDone: readonly string[];
  evaluationSuite: readonly string[];
  allowedTools: readonly string[];
  dataAccess: readonly DataClass[];
  writeScope: "none" | "isolated" | "external";
  mayDelegate: boolean;
  mayApprove: readonly string[];
  prohibited: readonly string[];
  requiredChecks: readonly string[];
  handoffRequirements: readonly string[];
  completionCriteria: readonly string[];
  escalationConditions: readonly string[];
  modelRouteId: string | null;
  independentFromRoleIds: readonly string[];
}

export interface AgentSummary {
  agentId: string;
  displayName: string;
  roleId: string;
  roleName: string;
  kind: RoleContract["kind"];
  roleWriteScope: RoleContract["writeScope"];
  parentAgentId: string | null;
  state: AgentState;
  currentGoalId: string | null;
  currentGoalTitle: string | null;
  sessionId: string | null;
  sessionState: SessionState | null;
  model: string | null;
  reasoning: string | null;
  workspaceId: string | null;
  lastHeartbeatAt: string | null;
  statusReason: string | null;
  temporary: boolean;
  archivedAt: string | null;
}

export interface AgentNode extends AgentSummary {
  children: AgentNode[];
}

export interface GoalSummary {
  goalId: string;
  parentGoalId: string | null;
  ownerAgentId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredChecks: string[];
  state: GoalState;
  riskLevel: RiskLevel;
  dataClass: DataClass;
  writeScope: "none" | "isolated_repository";
  externalEffects: string[];
  authorizedBy: string | null;
  artifactIdentity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventSummary {
  eventId: string;
  sequence: number;
  occurredAt: string;
  agentId: string | null;
  goalId: string | null;
  sessionId: string | null;
  ompSessionId: string | null;
  parentGoalId: string | null;
  type: string;
  severity: "info" | "warning" | "error";
  summary: string;
  statusBefore: string | null;
  statusAfter: string | null;
  toolName: string | null;
  workspaceId: string | null;
  filePaths: string[];
  commandSummary: string | null;
  evidenceRefs: string[];
  approvalRequestId: string | null;
  redactionApplied: boolean;
  sourceEventVersion: 1;
  metadata: Record<string, unknown>;
}

export interface MessageSummary {
  messageId: string;
  senderAgentId: string;
  recipientAgentId: string;
  goalId: string | null;
  sessionId: string;
  direction: "owner_to_agent" | "agent_to_agent" | "agent_to_owner";
  status: "queued" | "delivered" | "failed";
  content: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ApprovalSummary {
  approvalId: string;
  goalId: string;
  requestedByAgentId: string;
  action: string;
  target: string;
  artifactHash: string;
  requestHash: string;
  riskLevel: RiskLevel;
  expiresAt: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface EvidenceSummary {
  evidenceId: string;
  goalId: string;
  producerAgentId: string;
  verifierAgentId: string | null;
  evidenceType: string;
  candidateIdentity: string;
  result: EvidenceResult;
  summary: string;
  limitations: string[];
  artifactHash: string;
  createdAt: string;
}

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  goalId: string | null;
  ompSessionId: string | null;
  processId: number | null;
  state: SessionState;
  requestedProvider: string;
  requestedModel: string;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  reasoning: string;
  routeId: string;
  modelPolicyVersion: string;
  workspaceId: string | null;
  startedAt: string;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  errorCode: string | null;
  errorSummary: string | null;
}

export interface CheckDefinitionSummary {
  checkId: string;
  workspaceId: string;
  label: string;
  executable: string;
  arguments: string[];
  relativeCwd: string;
  timeoutMs: number;
  createdAt: string;
}

export interface CheckRunSummary {
  checkRunId: string;
  checkId: string;
  workspaceId: string;
  label: string;
  executable: string;
  arguments: string[];
  relativeCwd: string;
  goalId: string;
  agentId: string;
  candidateIdentity: string;
  result: "pass" | "fail" | "timeout" | "error";
  exitCode: number | null;
  outputSummary: string;
  startedAt: string;
  endedAt: string;
}

export interface ReleaseGateSummary {
  releaseCheckId: string;
  goalId: string;
  gate: "quality" | "security" | "owner_approval" | "artifact_identity";
  result: "pass" | "fail" | "missing" | "invalidated";
  evidenceId: string | null;
  artifactHash: string;
  recordedByAgentId: string;
  createdAt: string;
}

export interface TerritoryLeaseSummary {
  leaseId: string;
  goalId: string;
  agentId: string;
  workspaceId: string;
  path: string;
  mode: WorkspaceMode;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface WorkspaceSummary {
  workspaceId: string;
  goalId: string;
  agentId: string;
  integrationOwnerAgentId: string;
  repositoryRoot: string;
  worktreePath: string;
  baseRevision: string;
  currentRevision: string;
  mode: WorkspaceMode;
  state: "ready" | "dirty" | "released" | "quarantined";
  createdAt: string;
  releasedAt: string | null;
}
export interface WorkspaceChangeSummary {
  path: string;
  previousPath: string | null;
  indexStatus: string;
  workingTreeStatus: string;
}

export interface WorkspaceInspection {
  workspaceId: string;
  currentRevision: string;
  changes: WorkspaceChangeSummary[];
  changesTruncated: boolean;
  diffSummary: string;
  inspectedAt: string;
}

export interface ImprovementReviewSummary {
  reviewId: string;
  title: string;
  hypothesis: string;
  baseline: string;
  proposedChange: string;
  safetyMetric: string;
  evaluationPlan: string;
  state: ImprovementState;
  resultSummary: string | null;
  limitations: string[];
  sourceEventIds: string[];
  artifactIdentity: string;
  authorizedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  controller: {
    version: string;
    organizationName: string;
    ownerDisplayName: string;
    policyVersion: string;
    host: string;
    port: number;
    roleContractVersion: string;
    ompPath: string;
    ompVersion: string | null;
    safetyMode: "local_only";
  };
  counts: {
    activeAgents: number;
    runningGoals: number;
    waitingApprovals: number;
    blockedItems: number;
  };
  hierarchy: AgentNode[];
  agents: AgentSummary[];
  goals: GoalSummary[];
  events: EventSummary[];
  messages: MessageSummary[];
  approvals: ApprovalSummary[];
  evidence: EvidenceSummary[];
  checkDefinitions: CheckDefinitionSummary[];
  checkRuns: CheckRunSummary[];
  releaseGates: ReleaseGateSummary[];
  leases: TerritoryLeaseSummary[];
  workspaces: WorkspaceSummary[];
  improvements: ImprovementReviewSummary[];
}

export interface AgentDetail {
  agent: AgentSummary;
  role: RoleContract;
  goal: GoalSummary | null;
  workspace: WorkspaceSummary | null;
  workspaceInspection: WorkspaceInspection | null;
  sessions: SessionSummary[];
  checkDefinitions: CheckDefinitionSummary[];
  checkRuns: CheckRunSummary[];
  releaseGates: ReleaseGateSummary[];
  messages: MessageSummary[];
  events: EventSummary[];
  evidence: EvidenceSummary[];
  leases: TerritoryLeaseSummary[];
}

export interface ApiSession {
  csrfToken: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}
