import type { DataClass, GoalSummary, ModelRoute, RiskLevel, RoleContract } from "../shared/contracts.js";

export const MODEL_POLICY_VERSION = "2026-08-17.1";

export interface ModelEnvironment {
  ACCOMPLISH_OMP_PROVIDER?: string | undefined;
  ACCOMPLISH_MODEL_LUNA?: string | undefined;
  ACCOMPLISH_MODEL_TERRA?: string | undefined;
  ACCOMPLISH_MODEL_SOL?: string | undefined;
}

export interface ModelDecision {
  policyVersion: string;
  routeId: string;
  requestedProvider: string;
  requestedModel: string;
  reasoning: ModelRoute["reasoning"];
  fallback: readonly string[];
  derivedRisk: RiskLevel;
  rationale: string[];
}

export function buildModelRoutes(
  environment: ModelEnvironment = process.env,
): Readonly<Record<string, ModelRoute>> {
  const provider = environment.ACCOMPLISH_OMP_PROVIDER?.trim() || "openai-codex";
  const luna = environment.ACCOMPLISH_MODEL_LUNA?.trim() || "gpt-5.6-luna";
  const terra = environment.ACCOMPLISH_MODEL_TERRA?.trim() || "gpt-5.6-terra";
  const sol = environment.ACCOMPLISH_MODEL_SOL?.trim() || "gpt-5.6-sol";

  return {
    "route-routine-specialist": {
      routeId: "route-routine-specialist",
      provider,
      model: luna,
      reasoning: "low",
      fallback: [terra],
    },
    "route-complex-specialist": {
      routeId: "route-complex-specialist",
      provider,
      model: terra,
      reasoning: "high",
      fallback: [sol],
    },
    "route-routine-director": {
      routeId: "route-routine-director",
      provider,
      model: terra,
      reasoning: "medium",
      fallback: [sol],
    },
    "route-complex-director": {
      routeId: "route-complex-director",
      provider,
      model: sol,
      reasoning: "high",
      fallback: [],
    },
    "route-critical-director": {
      routeId: "route-critical-director",
      provider,
      model: sol,
      reasoning: "max",
      fallback: [],
    },
    "route-critical-review": {
      routeId: "route-critical-review",
      provider,
      model: sol,
      reasoning: "max",
      fallback: [],
    },
    "route-critical-orchestration": {
      routeId: "route-critical-orchestration",
      provider,
      model: sol,
      reasoning: "max",
      fallback: [],
    },
  };
}

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CRITICAL_EXTERNAL_EFFECTS: Readonly<Record<string, true>> = {
  production_deploy: true,
  money_movement: true,
  email_send: true,
  legal_commitment: true,
  customer_action: true,
  provider_enablement: true,
};

export function deriveRisk(input: {
  suppliedRisk: RiskLevel;
  dataClass: DataClass;
  writeScope: GoalSummary["writeScope"];
  externalEffects: readonly string[];
}): { risk: RiskLevel; rationale: string[] } {
  let risk = input.suppliedRisk;
  const rationale = [`supplied:${input.suppliedRisk}`];

  const raise = (candidate: RiskLevel, reason: string): void => {
    if (RISK_ORDER[candidate] > RISK_ORDER[risk]) {
      risk = candidate;
      rationale.push(reason);
    }
  };

  if (input.dataClass === "privileged") {
    raise("critical", "privileged-data");
  } else if (input.dataClass === "confidential") {
    raise("high", "confidential-data");
  }

  if (input.writeScope === "isolated_repository") {
    raise("medium", "isolated-repository-write");
  }

  if (input.externalEffects.some((effect) => CRITICAL_EXTERNAL_EFFECTS[effect])) {
    raise("critical", "consequential-external-effect");
  } else if (input.externalEffects.length > 0) {
    raise("high", "external-effect");
  }

  return { risk, rationale };
}

export function selectModel(
  role: RoleContract,
  goal: Pick<GoalSummary, "riskLevel" | "dataClass" | "writeScope" | "externalEffects">,
  routes: Readonly<Record<string, ModelRoute>>,
): ModelDecision {
  if (!role.modelRouteId) {
    throw new Error(`Role ${role.roleId} has no model route`);
  }

  const derived = deriveRisk({
    suppliedRisk: goal.riskLevel,
    dataClass: goal.dataClass,
    writeScope: goal.writeScope,
    externalEffects: goal.externalEffects,
  });

  const selectedRouteId = derived.risk === "critical" ? criticalRouteFor(role) : role.modelRouteId;
  const route = routes[selectedRouteId];
  if (!route) {
    throw new Error(`Model policy ${MODEL_POLICY_VERSION} references missing route ${selectedRouteId}`);
  }

  return {
    policyVersion: MODEL_POLICY_VERSION,
    routeId: route.routeId,
    requestedProvider: route.provider,
    requestedModel: route.model,
    reasoning: route.reasoning,
    fallback: route.fallback,
    derivedRisk: derived.risk,
    rationale: [...derived.rationale, `role:${role.roleId}`, `route:${selectedRouteId}`],
  };
}

function criticalRouteFor(role: RoleContract): string {
  if (role.kind === "verifier") {
    return "route-critical-review";
  }
  if (role.kind === "orchestrator") {
    return "route-critical-orchestration";
  }
  return "route-critical-director";
}
