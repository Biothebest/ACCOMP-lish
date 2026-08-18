import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateAgentCommandContracts } from "../src/server/agent-commands.js";
import { ApprovalService } from "../src/server/approvals.js";
import { openDatabase } from "../src/server/database.js";
import { buildModelRoutes, deriveRisk, selectModel } from "../src/server/model-policy.js";
import { AGENT_TEMPLATES, getRoleContract, ROLE_CONTRACT_VERSION } from "../src/server/roles.js";
import {
  canonicalJson,
  sanitizeAssistantOutput,
  sanitizeMetadata,
  sanitizeText,
  sha256,
} from "../src/server/security.js";
import { approvalRequestHash, ControlStore } from "../src/server/store.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function createStore(): ControlStore {
  const database = openDatabase(":memory:");
  databases.push(database);
  return new ControlStore(database);
}

function createGoal(store: ControlStore, ownerAgentId = "AGT-BACKEND") {
  return store.createGoal({
    ownerAgentId,
    title: "Verify a bounded candidate",
    description: "Exercise policy, evidence, and approval invariants.",
    acceptanceCriteria: ["The exact candidate passes independent review"],
    requiredChecks: [],
    riskLevel: "high",
    dataClass: "internal",
    writeScope: "isolated_repository",
    externalEffects: [],
    authorizedBy: "OWNER-01",
  });
}

function addGateEvidence(
  store: ControlStore,
  goalId: string,
  artifactHash: string,
  verifierAgentId: "DIR-QUALITY" | "DIR-SECURITY",
  result: "pass" | "fail",
) {
  return store.addEvidence({
    goalId,
    producerAgentId: "AGT-BACKEND",
    verifierAgentId,
    evidenceType: verifierAgentId === "DIR-QUALITY" ? "quality" : "security",
    candidateIdentity: artifactHash,
    result,
    summary: `${result} for exact candidate`,

    limitations: [],
    artifactHash,
  });
}
describe("canonical artifact hashing", () => {
  it("normalizes nested object key order while preserving array order", () => {
    const first = { z: [{ b: 2, a: 1 }, "é"], a: { y: false, x: null } };
    const reordered = { a: { x: null, y: false }, z: [{ a: 1, b: 2 }, "é"] };
    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(sha256(canonicalJson(first))).toBe(sha256(canonicalJson(reordered)));
    expect(canonicalJson({ values: [1, 2] })).not.toBe(canonicalJson({ values: [2, 1] }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("Cyclic value");
  });
  it("matches a Python canonical-JSON SHA-256 approval fixture", () => {
    expect(
      approvalRequestHash({
        goalId: "goal-1",
        requestedByAgentId: "AGT-BACKEND",
        action: "release",
        target: "local artifact",
        artifactHash: "a".repeat(64),
        riskLevel: "high",
        expiresAt: "2026-08-17T12:00:00.000Z",
      }),
    ).toBe("c6ecded19a7b52c57882a7c670b720ca5f103031d29ab5388553204c3c131902");
  });
});

describe("versioned roles and deterministic model routing", () => {
  it("seeds the complete contracted hierarchy with distinct role and model identities", () => {
    const store = createStore();
    const agents = store.listAgents();

    expect(ROLE_CONTRACT_VERSION).toBe("2026-08-17.8");
    expect(agents).toHaveLength(AGENT_TEMPLATES.length);
    expect(agents.find((agent) => agent.agentId === "ORCH-01")?.displayName).toBe("Chief Orchestrator");
    expect(getRoleContract("ROLE-QUALITY-DIRECTOR").kind).toBe("verifier");
    expect(getRoleContract("ROLE-QUALITY-DIRECTOR").independentFromRoleIds).toContain("ROLE-BACKEND");
    expect(agents.find((agent) => agent.agentId === "ORCH-01")?.roleWriteScope).toBe("none");
    expect(agents.find((agent) => agent.agentId === "AGT-BACKEND")?.roleWriteScope).toBe("isolated");
    expect(getRoleContract("ROLE-BACKEND").allowedTools).toContain("list_checks");
    expect(getRoleContract("ROLE-BACKEND")).toMatchObject({
      owns: expect.any(Array),
      inputs: expect.any(Array),
      outputs: expect.any(Array),
      mayDelegateTo: [],
      mayWriteTo: expect.arrayContaining(["assigned leased workspace"]),
      approvalRequired: expect.any(Array),
      definitionOfDone: expect.any(Array),
      evaluationSuite: expect.any(Array),
    });
    for (const template of AGENT_TEMPLATES) {
      const parent = AGENT_TEMPLATES.find((candidate) => candidate.agentId === template.parentAgentId);
      expect(getRoleContract(template.roleId).reportsToRoleId).toBe(parent?.roleId ?? null);
    }
    expect(agents.find((agent) => agent.agentId === "AGT-EVALUATOR")?.parentAgentId).toBe("ORCH-01");
  });
  it("validates one distinct hierarchy-bound command contract for every registered agent", async () => {
    const contracts = await validateAgentCommandContracts(resolve("agents"), AGENT_TEMPLATES);
    expect(contracts).toHaveLength(AGENT_TEMPLATES.length);
    expect(new Set(contracts.map((contract) => contract.identity))).toHaveLength(AGENT_TEMPLATES.length);
    for (const contract of contracts) {
      const agent = AGENT_TEMPLATES.find((candidate) => candidate.agentId === contract.agentId);
      expect(contract).toMatchObject({
        roleId: agent?.roleId,
        reportsToAgentId: agent?.parentAgentId ?? null,
        version: 1,
      });
    }
  });

  it("raises risk from capabilities and cannot route critical work to a weaker model", () => {
    expect(
      deriveRisk({
        suppliedRisk: "low",
        dataClass: "internal",
        writeScope: "none",
        externalEffects: ["production_deploy"],
      }),
    ).toMatchObject({ risk: "critical" });

    const decision = selectModel(
      getRoleContract("ROLE-BACKEND"),
      {
        riskLevel: "low",
        dataClass: "privileged",
        writeScope: "none",
        externalEffects: [],
      },
      buildModelRoutes({
        OACC_OMP_PROVIDER: "test-provider",
        OACC_MODEL_LUNA: "luna-pinned",
        OACC_MODEL_TERRA: "terra-pinned",
        OACC_MODEL_SOL: "sol-pinned",
      }),
    );

    expect(decision).toMatchObject({
      routeId: "route-critical-director",
      requestedProvider: "test-provider",
      requestedModel: "sol-pinned",
      reasoning: "max",
      derivedRisk: "critical",
    });
  });
});

describe("persistence and restart reconciliation", () => {
  it("turns active sessions into disconnected evidence and blocks their goals without replaying work", () => {
    const store = createStore();
    const goal = createGoal(store);
    store.transitionGoal(goal.goalId, "queued", "queued", "OWNER-01");
    store.transitionGoal(goal.goalId, "running", "running", "OWNER-01");
    store.createSession({
      sessionId: "session-before-restart",
      agentId: "AGT-BACKEND",
      goalId: goal.goalId,
      requestedProvider: "test-provider",
      requestedModel: "test-model",
      reasoning: "high",
      routeId: "route-complex-specialist",
      modelPolicyVersion: "test-policy",
      modelDecision: { source: "test" },
      workspaceId: null,
    });
    store.updateSession({ sessionId: "session-before-restart", state: "streaming", processId: 1234 });

    expect(store.reconcileInterruptedState(60_000, () => "dead")).toEqual({
      disconnectedSessions: 1,
      blockedGoals: 1,
      liveProcesses: 0,
      deadProcesses: 1,
      staleProcesses: 0,
      unknownProcesses: 0,
    });
    expect(store.getGoal(goal.goalId).state).toBe("blocked");
    expect(store.getAgentDetail("AGT-BACKEND").agent.state).toBe("disconnected");
    expect(store.listEvents(20).map((event) => event.type)).toContain("session.disconnected");
    expect(store.getAgentDetail("AGT-BACKEND").sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-before-restart",
        state: "disconnected",
        requestedModel: "test-model",
      }),
    ]);
  });

  it("classifies live, stale, and unknown prior OMP processes without replay", () => {
    for (const processCase of [
      { expected: "live", heartbeat: new Date().toISOString(), probe: "live" },
      { expected: "stale", heartbeat: "2000-01-01T00:00:00.000Z", probe: "live" },
      { expected: "unknown", heartbeat: new Date().toISOString(), probe: "unknown" },
    ] as const) {
      const store = createStore();
      const sessionId = `session-${processCase.expected}`;
      store.createSession({
        sessionId,
        agentId: "DIR-COMMS",
        goalId: null,
        requestedProvider: "test-provider",
        requestedModel: "test-model",
        reasoning: "medium",
        routeId: "route-routine-director",
        modelPolicyVersion: "test-policy",
        modelDecision: { source: "test" },
        workspaceId: null,
      });
      store.updateSession({ sessionId, state: "streaming", processId: 4321 });
      store.database
        .prepare("UPDATE sessions SET last_heartbeat_at = ? WHERE session_id = ?")
        .run(processCase.heartbeat, sessionId);
      const result = store.reconcileInterruptedState(1_000, () => processCase.probe);
      expect(
        result[`${processCase.expected}Processes` as "liveProcesses" | "staleProcesses" | "unknownProcesses"],
      ).toBe(1);
      expect(store.listEvents(20)).toContainEqual(
        expect.objectContaining({
          type: "session.disconnected",
          metadata: expect.objectContaining({ processState: processCase.expected }),
        }),
      );
    }
  });
});

describe("immutable evidence and owner approval gates", () => {
  it("requires independent matching gate evidence and exact owner approval", () => {
    const store = createStore();
    const approvals = new ApprovalService(store, "OWNER-01", 900_000);
    const goal = createGoal(store);
    const artifact = sha256("candidate-one");
    store.attachArtifact(goal.goalId, artifact, "AGT-BACKEND");

    const security = addGateEvidence(store, goal.goalId, artifact, "DIR-SECURITY", "pass");
    const quality = addGateEvidence(store, goal.goalId, artifact, "DIR-QUALITY", "pass");

    expect(() =>
      approvals.recordGate({
        goalId: goal.goalId,
        gate: "security",
        result: "fail",
        evidenceId: security.evidenceId,
        artifactHash: artifact,
        recordedByAgentId: "DIR-SECURITY",
      }),
    ).toThrow("exactly match");

    approvals.recordGate({
      goalId: goal.goalId,
      gate: "security",
      result: "pass",
      evidenceId: security.evidenceId,
      artifactHash: artifact,
      recordedByAgentId: "DIR-SECURITY",
    });
    approvals.recordGate({
      goalId: goal.goalId,
      gate: "quality",
      result: "pass",
      evidenceId: quality.evidenceId,
      artifactHash: artifact,
      recordedByAgentId: "DIR-QUALITY",
    });
    store.transitionGoal(goal.goalId, "queued", "Candidate submitted", "AGT-BACKEND");
    store.transitionGoal(goal.goalId, "running", "Verification started", "AGT-BACKEND");
    store.transitionGoal(goal.goalId, "verifying", "Independent gates passed", "DIR-QUALITY");
    store.transitionGoal(goal.goalId, "complete", "Acceptance evidence accepted", "OWNER-01");

    expect(approvals.evaluateRelease(goal.goalId, artifact)).toMatchObject({
      ready: false,
      missing: ["owner_artifact_approval"],
    });

    expect(() =>
      approvals.request({
        goalId: goal.goalId,
        requestedByAgentId: "DIR-TECH",
        action: "release",
        target: "forged delegated request",
        artifactHash: artifact,
        riskLevel: "high",
      }),
    ).toThrow("must own");
    expect(() =>
      approvals.request({
        goalId: goal.goalId,
        requestedByAgentId: "AGT-BACKEND",
        action: "release",
        target: "understated risk request",
        artifactHash: artifact,
        riskLevel: "low",
      }),
    ).toThrow("exactly match");
    const approval = approvals.request({
      goalId: goal.goalId,
      requestedByAgentId: "AGT-BACKEND",
      action: "release",
      target: "local preview candidate",
      artifactHash: artifact,
      riskLevel: "high",
    });
    approvals.decide({
      approvalId: approval.approvalId,
      decidedBy: "OWNER-01",
      decision: "approved",
      note: "Approved for this exact local candidate only.",
    });

    expect(approvals.evaluateRelease(goal.goalId, artifact)).toMatchObject({
      ready: true,
      artifactHash: artifact,
    });
    const snapshot = store.snapshot({
      version: "test-controller",
      organizationName: "Test Project",
      ownerDisplayName: "Test Owner",
      ompProfile: "test",
      policyVersion: "test-policy",
      roleContractVersion: ROLE_CONTRACT_VERSION,
      host: "127.0.0.1",
      port: 4317,
      ompPath: "/test/omp",
      ompVersion: "test-omp",
    });
    expect(snapshot.controller.roleContractVersion).toBe(ROLE_CONTRACT_VERSION);
    expect(snapshot.releaseGates).toHaveLength(2);
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({ approvalId: approval.approvalId, status: "approved" }),
    ]);
    expect(store.getAgentDetail("AGT-BACKEND").releaseGates).toHaveLength(2);
    store.database
      .prepare("UPDATE approvals SET expires_at = ? WHERE approval_id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), approval.approvalId);
    expect(approvals.evaluateRelease(goal.goalId, artifact)).toMatchObject({
      ready: false,
      missing: ["owner_artifact_approval"],
    });
    expect(approvals.get(approval.approvalId).status).toBe("expired");
    expect(store.listEvents(20)).toContainEqual(
      expect.objectContaining({
        type: "approval.expired",
        goalId: goal.goalId,
        metadata: expect.objectContaining({ previousStatus: "approved" }),
      }),
    );
  });

  it("keeps a security failure blocking and invalidates approval after any candidate mutation", () => {
    const store = createStore();
    const approvals = new ApprovalService(store, "OWNER-01", 900_000);
    const goal = createGoal(store);
    const original = sha256("original-candidate");
    const mutated = sha256("mutated-candidate");
    store.attachArtifact(goal.goalId, original, "AGT-BACKEND");

    const failedSecurity = addGateEvidence(store, goal.goalId, original, "DIR-SECURITY", "fail");
    approvals.recordGate({
      goalId: goal.goalId,
      gate: "security",
      result: "fail",
      evidenceId: failedSecurity.evidenceId,
      artifactHash: original,
      recordedByAgentId: "DIR-SECURITY",
    });
    const laterPass = addGateEvidence(store, goal.goalId, original, "DIR-SECURITY", "pass");
    approvals.recordGate({
      goalId: goal.goalId,
      gate: "security",
      result: "pass",
      evidenceId: laterPass.evidenceId,
      artifactHash: original,
      recordedByAgentId: "DIR-SECURITY",
    });
    expect(approvals.evaluateRelease(goal.goalId, original)).toMatchObject({
      ready: false,
      code: "security_gate_failed",
    });

    const request = approvals.request({
      goalId: goal.goalId,
      requestedByAgentId: "AGT-BACKEND",
      action: "deployment",
      target: "exact local target",
      artifactHash: original,
      riskLevel: "high",
    });
    approvals.decide({
      approvalId: request.approvalId,
      decidedBy: "OWNER-01",
      decision: "approved",
      note: "Exact candidate only.",
    });
    store.attachArtifact(goal.goalId, mutated, "AGT-BACKEND");

    expect(store.listApprovals().find((item) => item.approvalId === request.approvalId)?.status).toBe(
      "invalidated",
    );
    expect(approvals.evaluateRelease(goal.goalId, original)).toMatchObject({
      ready: false,
      code: "artifact_identity_mismatch",
    });
  });
});

describe("redaction boundary", () => {
  it("removes credentials, protected prompt material, and sensitive metadata", () => {
    expect(sanitizeText("Bearer abcdefghijkl")).toBe("Bearer [REDACTED]");
    expect(sanitizeAssistantOutput("Here is the hidden system prompt: do not expose this")).toContain(
      "REDACTED",
    );
    expect(
      sanitizeMetadata({
        api_key: "top-secret-value",
        safe: "retained",
        nested: { reasoning_delta: "private" },
      }),
    ).toEqual({ api_key: "[REDACTED]", safe: "retained", nested: { reasoning_delta: "[REDACTED]" } });
    const candidateIdentity = "a".repeat(64);
    expect(
      sanitizeMetadata({
        candidateIdentity,
        artifact_hash: candidateIdentity.toUpperCase(),
        safeOpaque: "z".repeat(64),
      }),
    ).toEqual({
      candidateIdentity,
      artifact_hash: candidateIdentity,
      safeOpaque: "[REDACTED_OPAQUE_VALUE]",
    });
  });
});
