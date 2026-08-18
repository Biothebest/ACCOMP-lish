import type { LiveEvent } from "../server/events.js";
import type {
  AgentDetail,
  ApiErrorBody,
  ApiSession,
  DashboardSnapshot,
  ImprovementState,
} from "../shared/contracts.js";

export class DashboardApiError extends Error {
  override readonly name = "DashboardApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}
export interface CreateGoalRequest {
  ownerAgentId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredChecks: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
  dataClass: "public" | "internal" | "confidential" | "privileged";
  writeScope: "none" | "isolated_repository";
  externalEffects: string[];
}
export interface WorkspaceCheckInput {
  label: string;
  executable: string;
  arguments: string[];
  relativeCwd: string;
  timeoutMs: number;
}
export interface CreateImprovementRequest {
  title: string;
  hypothesis: string;
  baseline: string;
  proposedChange: string;
  safetyMetric: string;
  evaluationPlan: string;
  sourceEventIds: string[];
}

export class DashboardApi {
  private csrfToken: string | null = null;

  async connect(): Promise<void> {
    const session = await this.request<ApiSession>("/api/session", { method: "GET" }, false);
    this.csrfToken = session.csrfToken;
  }

  snapshot(signal?: AbortSignal): Promise<DashboardSnapshot> {
    return this.request<DashboardSnapshot>("/api/snapshot", { method: "GET", ...(signal ? { signal } : {}) });
  }

  agentDetail(agentId: string, signal?: AbortSignal): Promise<AgentDetail> {
    return this.request<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
  }

  async startAgent(agentId: string): Promise<{ sessionId: string }> {
    return this.mutate(`/api/agents/${encodeURIComponent(agentId)}/start`, {});
  }

  async sendMessage(agentId: string, message: string): Promise<{ messageId: string }> {
    return this.mutate(`/api/agents/${encodeURIComponent(agentId)}/message`, { message });
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.mutate(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {});
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.mutate(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {});
  }

  async createGoal(input: CreateGoalRequest): Promise<{ goalId: string }> {
    return this.mutate("/api/goals", input);
  }

  async startGoal(goalId: string): Promise<{ sessionId: string }> {
    return this.mutate(`/api/goals/${encodeURIComponent(goalId)}/start`, {});
  }
  async retryGoal(goalId: string, reason: string): Promise<{ sessionId: string }> {
    return this.mutate(`/api/goals/${encodeURIComponent(goalId)}/retry`, { reason });
  }

  async completeGoal(goalId: string): Promise<void> {
    await this.mutate(`/api/goals/${encodeURIComponent(goalId)}/complete`, {});
  }

  async rollbackGoal(goalId: string, reason: string): Promise<void> {
    await this.mutate(`/api/goals/${encodeURIComponent(goalId)}/rollback`, { reason });
  }

  async createWorkspace(
    goalId: string,
    repositoryPath: string,
    baseRef: string,
    mode: "read" | "write",
    territoryPath: string,
    checks: WorkspaceCheckInput[],
  ): Promise<{ workspaceId: string; leaseId: string; checkIds: string[] }> {
    return this.mutate("/api/workspaces", {
      goalId,
      repositoryPath,
      baseRef,
      mode,
      territoryPath,
      territoryTtlMs: 3_600_000,
      checks,
    });
  }

  async decideApproval(approvalId: string, decision: "approved" | "rejected", note: string): Promise<void> {
    await this.mutate(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, { decision, note });
  }

  async createImprovement(input: CreateImprovementRequest): Promise<void> {
    await this.mutate("/api/improvements", input);
  }

  async transitionImprovement(
    reviewId: string,
    state: Exclude<ImprovementState, "proposed">,
    resultSummary: string,
    limitations: string[],
  ): Promise<void> {
    await this.mutate(`/api/improvements/${encodeURIComponent(reviewId)}/transition`, {
      state,
      resultSummary,
      limitations,
    });
  }

  subscribe(onEvent: (event: LiveEvent) => void, onConnection: (connected: boolean) => void): () => void {
    const source = new EventSource("/events");
    source.addEventListener("ready", () => onConnection(true));
    source.addEventListener("update", (message) => {
      if (message instanceof MessageEvent && typeof message.data === "string") {
        try {
          onEvent(JSON.parse(message.data) as LiveEvent);
        } catch {
          onConnection(false);
        }
      }
    });
    source.onerror = () => onConnection(false);
    return () => source.close();
  }

  private mutate<T>(path: string, body: unknown): Promise<T> {
    if (!this.csrfToken) {
      return Promise.reject(new DashboardApiError("Local session is not connected", 401, "not_connected"));
    }
    return this.request<T>(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": this.csrfToken,
      },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit, authenticated = true): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "same-origin" });
    if (!response.ok) {
      let body: ApiErrorBody = { error: `Request failed with HTTP ${response.status}`, code: "http_error" };
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        // Keep the bounded HTTP status fallback.
      }
      if (response.status === 401 && authenticated) {
        this.csrfToken = null;
      }
      throw new DashboardApiError(body.error, response.status, body.code);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
