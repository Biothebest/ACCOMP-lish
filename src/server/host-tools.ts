import { z } from "zod";
import type { RoleContract, WorkspaceSummary } from "../shared/contracts.js";
import type { ApprovalService } from "./approvals.js";
import type { CheckRunner } from "./checks.js";
import { sanitizeMetadata } from "./security.js";
import type { ControlStore } from "./store.js";
import type { WorkspaceManager } from "./workspaces.js";

export interface HostToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolBinding {
  agentId: string;
  goalId: string | null;
  workspaceId: string | null;
  canWriteWorkspace: boolean;
  role: RoleContract;
}

export interface HostToolCallbacks {
  relayMessage(input: {
    senderAgentId: string;
    recipientAgentId: string;
    goalId: string | null;
    message: string;
  }): Promise<{ messageId: string }>;
  createChildGoal(input: {
    requestingAgentId: string;
    parentGoalId: string;
    ownerAgentId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requiredChecks: string[];
  }): Promise<{ goalId: string }>;
  createVerificationGoal(input: {
    requestingAgentId: string;
    subjectGoalId: string;
    verifierAgentId: string;
  }): Promise<{ goalId: string }>;
  startChildAgent(input: { requestingAgentId: string; goalId: string }): Promise<{ sessionId: string }>;
}

const TOOL_DEFINITIONS: Readonly<Record<string, HostToolDefinition>> = {
  get_goal_context: {
    name: "get_goal_context",
    label: "Get goal context",
    description:
      "Read the exact assigned goal and artifact; verifier goals also receive their exact parent subject and durable public outcome.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  list_agents: {
    name: "list_agents",
    label: "List agents",
    description: "List registered agent identities, roles, hierarchy, and public operational state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  workspace_list: {
    name: "workspace_list",
    label: "List workspace",
    description:
      "List one directory in the assigned workspace, or an exact immutable subject candidate for an independent verifier.",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", maxLength: 500 },
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
      },
      additionalProperties: false,
    },
  },
  workspace_read: {
    name: "workspace_read",
    label: "Read workspace file",
    description:
      "Read one safe file from the assigned workspace, or an exact immutable subject candidate for an independent verifier.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500 },
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  workspace_search: {
    name: "workspace_search",
    label: "Search workspace",
    description:
      "Search the assigned workspace, or an exact immutable subject candidate for an independent verifier.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  workspace_write: {
    name: "workspace_write",
    label: "Write workspace file",
    description: "Atomically replace one file covered by an active write territory lease.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500 },
        content: { type: "string", maxLength: 1_048_576 },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  apply_patch: {
    name: "apply_patch",
    label: "Apply exact replacement",
    description: "Replace text that occurs exactly once in one file under an active write territory lease.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 500 },
        before: { type: "string", minLength: 1, maxLength: 100_000 },
        after: { type: "string", maxLength: 100_000 },
      },
      required: ["path", "before", "after"],
      additionalProperties: false,
    },
  },
  list_checks: {
    name: "list_checks",
    label: "List registered checks",
    description:
      "List exact pre-registered checks for the assigned workspace or independent verifier subject candidate.",
    parameters: {
      type: "object",
      properties: {
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
      },
      additionalProperties: false,
    },
  },
  run_check: {
    name: "run_check",
    label: "Run registered check",
    description:
      "Run one pre-registered, network-denied check in the assigned workspace or exact verifier subject candidate.",
    parameters: {
      type: "object",
      properties: {
        check_id: { type: "string", minLength: 1, maxLength: 100 },
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
      },
      required: ["check_id"],
      additionalProperties: false,
    },
  },
  submit_candidate: {
    name: "submit_candidate",
    label: "Submit immutable candidate",
    description:
      "Compute the assigned workspace identity at the controller boundary and attach it to the exact goal for independent verification.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  send_agent_message: {
    name: "send_agent_message",
    label: "Send agent handoff",
    description:
      "Relay one bounded message to an exact registered read-only OMP session through the controller.",
    parameters: {
      type: "object",
      properties: {
        recipient_agent_id: { type: "string", minLength: 1, maxLength: 100 },
        message: { type: "string", minLength: 1, maxLength: 8_000 },
      },
      required: ["recipient_agent_id", "message"],
      additionalProperties: false,
    },
  },
  create_child_goal: {
    name: "create_child_goal",
    label: "Create child goal",
    description:
      "Create a bounded child goal for a permitted registered descendant; no session starts automatically.",
    parameters: {
      type: "object",
      properties: {
        owner_agent_id: { type: "string", minLength: 1, maxLength: 100 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: "string", minLength: 1, maxLength: 4_000 },
        acceptance_criteria: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        required_checks: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
      required: ["owner_agent_id", "title", "description", "acceptance_criteria", "required_checks"],
      additionalProperties: false,
    },
  },
  request_verification: {
    name: "request_verification",
    label: "Request independent verification",
    description:
      "Create a controller-authored read-only verification goal for one exact delegated subject candidate and an independent verifier.",
    parameters: {
      type: "object",
      properties: {
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
        verifier_agent_id: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["subject_goal_id", "verifier_agent_id"],
      additionalProperties: false,
    },
  },
  start_child_agent: {
    name: "start_child_agent",
    label: "Start child agent",
    description: "Start the explicitly assigned child goal after controller policy validation.",
    parameters: {
      type: "object",
      properties: { goal_id: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["goal_id"],
      additionalProperties: false,
    },
  },
  submit_evidence: {
    name: "submit_evidence",
    label: "Submit evidence",
    description: "Record bounded observable evidence for the exact current candidate identity.",
    parameters: {
      type: "object",
      properties: {
        evidence_type: { type: "string", minLength: 1, maxLength: 100 },
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
        producer_agent_id: { type: "string", minLength: 1, maxLength: 100 },
        candidate_identity: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        result: { type: "string", enum: ["pass", "fail", "unverified"] },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        limitations: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
      required: ["evidence_type", "candidate_identity", "result", "summary", "limitations"],
      additionalProperties: false,
    },
  },
  record_release_gate: {
    name: "record_release_gate",
    label: "Record independent release gate",
    description:
      "Bind one quality or security gate result to evidence produced by this exact independent verifier.",
    parameters: {
      type: "object",
      properties: {
        subject_goal_id: { type: "string", minLength: 1, maxLength: 150 },
        gate: { type: "string", enum: ["quality", "security"] },
        result: { type: "string", enum: ["pass", "fail", "unverified"] },
        evidence_id: { type: "string", minLength: 1, maxLength: 150 },
        candidate_identity: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      },
      required: ["subject_goal_id", "gate", "result", "evidence_id", "candidate_identity"],
      additionalProperties: false,
    },
  },
  request_approval: {
    name: "request_approval",
    label: "Request owner approval",
    description: "Create an exact, expiring owner approval request bound to the current artifact identity.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", minLength: 1, maxLength: 100 },
        target: { type: "string", minLength: 1, maxLength: 500 },
        artifact_hash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
      },
      required: ["action", "target", "artifact_hash", "risk_level"],
      additionalProperties: false,
    },
  },
};

const EMPTY_OBJECT = z.object({}).strict();
const SUBJECT_GOAL_ID = z.string().min(1).max(150).optional();
const OPTIONAL_DIRECTORY = z
  .object({ directory: z.string().max(500).optional(), subject_goal_id: SUBJECT_GOAL_ID })
  .strict();
const PATH_INPUT = z.object({ path: z.string().min(1).max(500), subject_goal_id: SUBJECT_GOAL_ID }).strict();
const SEARCH_INPUT = z
  .object({ query: z.string().min(1).max(200), subject_goal_id: SUBJECT_GOAL_ID })
  .strict();
const WRITE_INPUT = z
  .object({ path: z.string().min(1).max(500), content: z.string().max(1_048_576) })
  .strict();
const PATCH_INPUT = z
  .object({
    path: z.string().min(1).max(500),
    before: z.string().min(1).max(100_000),
    after: z.string().max(100_000),
  })
  .strict();
const CHECK_LIST_INPUT = z.object({ subject_goal_id: SUBJECT_GOAL_ID }).strict();
const CHECK_INPUT = z
  .object({ check_id: z.string().min(1).max(100), subject_goal_id: SUBJECT_GOAL_ID })
  .strict();
const MESSAGE_INPUT = z
  .object({ recipient_agent_id: z.string().min(1).max(100), message: z.string().min(1).max(8_000) })
  .strict();
const CHILD_GOAL_INPUT = z
  .object({
    owner_agent_id: z.string().min(1).max(100),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(4_000),
    acceptance_criteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    required_checks: z.array(z.string().min(1).max(120)).max(20),
  })
  .strict();
const CHILD_SESSION_INPUT = z.object({ goal_id: z.string().min(1).max(100) }).strict();
const EVIDENCE_INPUT = z
  .object({
    evidence_type: z.string().min(1).max(100),
    subject_goal_id: z.string().min(1).max(150).optional(),
    producer_agent_id: z.string().min(1).max(100).optional(),
    candidate_identity: z.string().regex(/^[a-fA-F0-9]{64}$/),
    result: z.enum(["pass", "fail", "unverified"]),
    summary: z.string().min(1).max(2_000),
    limitations: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();
const APPROVAL_INPUT = z
  .object({
    action: z.string().min(1).max(100),
    target: z.string().min(1).max(500),
    artifact_hash: z.string().regex(/^[a-fA-F0-9]{64}$/),
    risk_level: z.enum(["low", "medium", "high", "critical"]),
  })
  .strict();
const RELEASE_GATE_INPUT = z
  .object({
    subject_goal_id: z.string().min(1).max(150),
    gate: z.enum(["quality", "security"]),
    result: z.enum(["pass", "fail", "unverified"]),
    evidence_id: z.string().min(1).max(150),
    candidate_identity: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();

const WORKSPACE_TOOLS = new Set([
  "workspace_list",
  "workspace_read",
  "workspace_search",
  "workspace_write",
  "apply_patch",
  "list_checks",
  "run_check",
  "submit_candidate",
]);
const VERIFIER_INSPECTION_TOOLS = new Set([
  "workspace_list",
  "workspace_read",
  "workspace_search",
  "list_checks",
  "run_check",
]);
const WORKSPACE_WRITE_TOOLS = new Set(["workspace_write", "apply_patch", "submit_candidate"]);
const VERIFICATION_GOAL_INPUT = z
  .object({
    subject_goal_id: z.string().min(1).max(150),
    verifier_agent_id: z.string().min(1).max(100),
  })
  .strict();
export class HostToolExecutor {
  constructor(
    private readonly store: ControlStore,
    private readonly workspaces: WorkspaceManager,
    private readonly checks: CheckRunner,
    private readonly approvals: ApprovalService,
    private readonly callbacks: HostToolCallbacks,
  ) {}

  definitionsFor(binding: ToolBinding): HostToolDefinition[] {
    return binding.role.allowedTools
      .filter((toolName) => {
        const verifierInspection =
          binding.role.kind === "verifier" && VERIFIER_INSPECTION_TOOLS.has(toolName);
        return (
          (!WORKSPACE_TOOLS.has(toolName) || binding.workspaceId !== null || verifierInspection) &&
          (!WORKSPACE_WRITE_TOOLS.has(toolName) || binding.canWriteWorkspace)
        );
      })
      .map((toolName) => {
        const definition = TOOL_DEFINITIONS[toolName];
        if (!definition) {
          throw new Error(`Role ${binding.role.roleId} references unknown host tool ${toolName}`);
        }
        return definition;
      });
  }

  async execute(binding: ToolBinding, toolName: string, arguments_: unknown): Promise<unknown> {
    if (!binding.role.allowedTools.includes(toolName)) {
      throw new Error(`Tool ${toolName} is not allowed for role ${binding.role.roleId}`);
    }
    const verifierInspection = binding.role.kind === "verifier" && VERIFIER_INSPECTION_TOOLS.has(toolName);
    if (WORKSPACE_TOOLS.has(toolName) && !binding.workspaceId && !verifierInspection) {
      throw new Error(`Tool ${toolName} requires an assigned isolated workspace`);
    }
    if (WORKSPACE_WRITE_TOOLS.has(toolName) && !binding.canWriteWorkspace) {
      throw new Error(`Tool ${toolName} requires explicit write-capable workspace authority`);
    }
    if (toolName === "get_goal_context") {
      EMPTY_OBJECT.parse(arguments_);
      if (!binding.goalId) {
        return { goal: null };
      }
      const goal = this.store.getGoal(binding.goalId);
      if (binding.role.kind !== "verifier" || !goal.parentGoalId) {
        return goal;
      }
      const subject = this.store.getGoal(goal.parentGoalId);
      return {
        ...goal,
        verificationSubject: {
          goal: subject,
          durableOutput: this.store.getGoalOutput(subject.goalId),
        },
      };
    }
    if (toolName === "list_agents") {
      EMPTY_OBJECT.parse(arguments_);
      return this.store
        .listAgents()
        .map(({ agentId, displayName, roleId, roleName, parentAgentId, state, currentGoalId }) => ({
          agentId,
          displayName,
          roleId,
          roleName,
          parentAgentId,
          state,
          currentGoalId,
        }));
    }
    if (toolName === "workspace_list") {
      const input = OPTIONAL_DIRECTORY.parse(arguments_);
      const access = await this.resolveReadableWorkspace(binding, input.subject_goal_id);
      const result = await this.workspaces.listFiles(
        access.workspace.agentId,
        access.workspace.workspaceId,
        input.directory ?? ".",
      );
      await this.confirmCandidateIdentity(access, binding.agentId);
      return result;
    }
    if (toolName === "workspace_read") {
      const input = PATH_INPUT.parse(arguments_);
      const access = await this.resolveReadableWorkspace(binding, input.subject_goal_id);
      const content = access.candidateIdentity
        ? await this.workspaces.readImmutableCandidateFile(access.workspace.workspaceId, input.path)
        : await this.workspaces.readWorkspaceFile(binding.agentId, access.workspace.workspaceId, input.path);
      await this.confirmCandidateIdentity(access, binding.agentId);
      return { path: input.path, content };
    }
    if (toolName === "workspace_search") {
      const input = SEARCH_INPUT.parse(arguments_);
      const access = await this.resolveReadableWorkspace(binding, input.subject_goal_id);
      const result = await this.workspaces.searchWorkspace(
        access.workspace.agentId,
        access.workspace.workspaceId,
        input.query,
      );
      await this.confirmCandidateIdentity(access, binding.agentId);
      return result;
    }
    if (toolName === "workspace_write") {
      const input = WRITE_INPUT.parse(arguments_);
      await this.workspaces.writeWorkspaceFile(
        binding.agentId,
        requireWorkspace(binding),
        input.path,
        input.content,
      );
      return { written: input.path };
    }
    if (toolName === "apply_patch") {
      const input = PATCH_INPUT.parse(arguments_);
      await this.workspaces.replaceExactText(
        binding.agentId,
        requireWorkspace(binding),
        input.path,
        input.before,
        input.after,
      );
      return { updated: input.path };
    }
    if (toolName === "list_checks") {
      const input = CHECK_LIST_INPUT.parse(arguments_);
      const access = await this.resolveReadableWorkspace(binding, input.subject_goal_id);
      return this.store
        .listCheckDefinitions(500)
        .filter((check) => check.workspaceId === access.workspace.workspaceId);
    }
    if (toolName === "run_check") {
      const input = CHECK_INPUT.parse(arguments_);
      const access = await this.resolveReadableWorkspace(binding, input.subject_goal_id);
      const result = await this.checks.run({
        checkId: input.check_id,
        agentId: binding.agentId,
        workspaceAgentId: access.workspace.agentId,
        goalId: access.workspace.goalId,
      });
      await this.confirmCandidateIdentity(access, binding.agentId);
      return result;
    }
    if (toolName === "submit_candidate") {
      EMPTY_OBJECT.parse(arguments_);
      const goalId = requireGoal(binding);
      const workspace = this.workspaces.getWorkspace(requireWorkspace(binding));
      if (
        workspace.agentId !== binding.agentId ||
        workspace.goalId !== goalId ||
        !["ready", "dirty"].includes(workspace.state)
      ) {
        throw new Error("Candidate submission requires the exact active goal workspace");
      }
      const candidateIdentity = await this.checks.computeCandidateIdentity(workspace.worktreePath);
      this.store.attachArtifact(goalId, candidateIdentity, binding.agentId);
      return { goalId, candidateIdentity };
    }
    if (toolName === "send_agent_message") {
      const input = MESSAGE_INPUT.parse(arguments_);
      return this.callbacks.relayMessage({
        senderAgentId: binding.agentId,
        recipientAgentId: input.recipient_agent_id,
        goalId: binding.goalId,
        message: input.message,
      });
    }
    if (toolName === "create_child_goal") {
      const input = CHILD_GOAL_INPUT.parse(arguments_);
      return this.callbacks.createChildGoal({
        requestingAgentId: binding.agentId,
        parentGoalId: requireGoal(binding),
        ownerAgentId: input.owner_agent_id,
        title: input.title,
        requiredChecks: input.required_checks,
        description: input.description,
        acceptanceCriteria: input.acceptance_criteria,
      });
    }
    if (toolName === "request_verification") {
      const input = VERIFICATION_GOAL_INPUT.parse(arguments_);
      return this.callbacks.createVerificationGoal({
        requestingAgentId: binding.agentId,
        subjectGoalId: input.subject_goal_id,
        verifierAgentId: input.verifier_agent_id,
      });
    }
    if (toolName === "start_child_agent") {
      const input = CHILD_SESSION_INPUT.parse(arguments_);
      return this.callbacks.startChildAgent({ requestingAgentId: binding.agentId, goalId: input.goal_id });
    }
    if (toolName === "submit_evidence") {
      const input = EVIDENCE_INPUT.parse(arguments_);
      const assignedGoalId = requireGoal(binding);
      const assignedGoal = this.store.getGoal(assignedGoalId);
      const isVerifier = binding.role.kind === "verifier";
      const subjectGoalId = isVerifier ? input.subject_goal_id : assignedGoalId;
      const producerAgentId = isVerifier ? input.producer_agent_id : binding.agentId;
      if (!subjectGoalId || !producerAgentId) {
        throw new Error("Independent evidence requires subject_goal_id and producer_agent_id");
      }
      const subjectGoal = this.store.getGoal(subjectGoalId);
      if (isVerifier) {
        if (assignedGoal.parentGoalId !== subjectGoalId || subjectGoal.ownerAgentId !== producerAgentId) {
          throw new Error("Verifier evidence must target its exact parent candidate goal and producer");
        }
        if (!this.approvals.verifierIsIndependent(binding.agentId, producerAgentId)) {
          throw new Error("Verifier is not independent from the candidate producer");
        }
      }
      if (subjectGoal.artifactIdentity !== input.candidate_identity) {
        throw new Error("Evidence candidate identity does not match the current subject artifact");
      }
      return this.store.addEvidence({
        goalId: subjectGoalId,
        producerAgentId,
        verifierAgentId: isVerifier ? binding.agentId : null,
        evidenceType: input.evidence_type,
        candidateIdentity: input.candidate_identity,
        result: input.result,
        summary: input.summary,
        limitations: input.limitations,
        artifactHash: input.candidate_identity,
      });
    }
    if (toolName === "record_release_gate") {
      const input = RELEASE_GATE_INPUT.parse(arguments_);
      const assignedGoal = this.store.getGoal(requireGoal(binding));
      if (binding.role.kind !== "verifier" || assignedGoal.parentGoalId !== input.subject_goal_id) {
        throw new Error("Release gate must target the exact subject of the assigned verification goal");
      }
      this.approvals.recordGate({
        goalId: input.subject_goal_id,
        gate: input.gate,
        result: input.result,
        evidenceId: input.evidence_id,
        artifactHash: input.candidate_identity,
        recordedByAgentId: binding.agentId,
      });
      return { recorded: input.gate, candidateIdentity: input.candidate_identity };
    }
    if (toolName === "request_approval") {
      const input = APPROVAL_INPUT.parse(arguments_);
      const goalId = requireGoal(binding);
      await this.checks.assertCurrentCandidate(goalId);
      return this.approvals.request({
        goalId,
        requestedByAgentId: binding.agentId,
        action: input.action,
        target: input.target,
        artifactHash: input.artifact_hash,
        riskLevel: input.risk_level,
      });
    }
    throw new Error(`No host tool implementation for ${toolName}`);
  }

  private async resolveReadableWorkspace(
    binding: ToolBinding,
    subjectGoalId: string | undefined,
  ): Promise<{ workspace: WorkspaceSummary; candidateIdentity: string | null }> {
    if (binding.workspaceId) {
      if (subjectGoalId) {
        throw new Error("Only an independent verifier may select a subject candidate workspace");
      }
      const workspace = this.workspaces.getWorkspace(binding.workspaceId);
      if (!binding.goalId || workspace.goalId !== binding.goalId) {
        throw new Error("Assigned workspace does not match the current bounded goal");
      }
      return { workspace, candidateIdentity: null };
    }
    if (binding.role.kind !== "verifier" || !subjectGoalId || !binding.goalId) {
      throw new Error(
        "Verifier candidate inspection requires an assigned verification goal and subject_goal_id",
      );
    }
    const verificationGoal = this.store.getGoal(binding.goalId);
    const subjectGoal = this.store.getGoal(subjectGoalId);
    if (verificationGoal.parentGoalId !== subjectGoalId) {
      throw new Error("Verifier candidate inspection must target its exact parent subject goal");
    }
    if (!subjectGoal.artifactIdentity) {
      throw new Error("Verifier candidate inspection requires an attached immutable candidate identity");
    }
    if (!this.approvals.verifierIsIndependent(binding.agentId, subjectGoal.ownerAgentId)) {
      throw new Error("Verifier is not independent from the candidate producer");
    }
    const workspace = this.store
      .listWorkspaces()
      .find(
        (candidate) =>
          candidate.goalId === subjectGoalId &&
          candidate.agentId === subjectGoal.ownerAgentId &&
          candidate.state !== "released" &&
          candidate.state !== "quarantined",
      );
    if (!workspace) {
      throw new Error("Subject goal has no active candidate workspace");
    }
    const actualIdentity = await this.checks.computeCandidateIdentity(workspace.worktreePath);
    if (actualIdentity !== subjectGoal.artifactIdentity) {
      this.store.invalidateArtifact(subjectGoalId, binding.agentId, "Verifier observed candidate drift");
      throw new Error("Subject candidate no longer matches its attached immutable identity");
    }
    return { workspace, candidateIdentity: subjectGoal.artifactIdentity };
  }

  private async confirmCandidateIdentity(
    access: { workspace: WorkspaceSummary; candidateIdentity: string | null },
    actorAgentId: string,
  ): Promise<void> {
    if (!access.candidateIdentity) {
      return;
    }
    const goal = this.store.getGoal(access.workspace.goalId);
    const actualIdentity = await this.checks.computeCandidateIdentity(access.workspace.worktreePath);
    if (goal.artifactIdentity !== access.candidateIdentity || actualIdentity !== access.candidateIdentity) {
      if (goal.artifactIdentity) {
        this.store.invalidateArtifact(goal.goalId, actorAgentId, "Candidate changed during verification");
      }
      throw new Error("Subject candidate changed during verification");
    }
  }

  safeResult(value: unknown): string {
    const sanitized = Array.isArray(value)
      ? value.map((item) => sanitizeMetadata(item))
      : sanitizeMetadata(value);
    return JSON.stringify(sanitized);
  }
}

function requireGoal(binding: ToolBinding): string {
  if (!binding.goalId) {
    throw new Error("This tool requires an assigned goal");
  }
  return binding.goalId;
}

function requireWorkspace(binding: ToolBinding): string {
  if (!binding.workspaceId) {
    throw new Error("This tool requires an assigned isolated workspace");
  }
  return binding.workspaceId;
}
