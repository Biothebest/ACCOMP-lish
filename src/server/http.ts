import { existsSync } from "node:fs";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import type { ApiErrorBody } from "../shared/contracts.js";
import { AuthenticationError, LocalSessionAuth } from "./auth.js";
import { CONTROLLER_VERSION, type ControlCenter } from "./control-center.js";
import { ROLE_CONTRACT_VERSION } from "./roles.js";
import { assertLoopbackHost, sanitizeError } from "./security.js";

const ID_PARAMS = z.object({ id: z.string().min(1).max(150) }).strict();
const AGENT_PARAMS = z.object({ agentId: z.string().min(1).max(100) }).strict();
const GOAL_INPUT = z
  .object({
    ownerAgentId: z.string().min(1).max(100),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(4_000),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(30),
    requiredChecks: z.array(z.string().min(1).max(160)).max(30).default([]),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    dataClass: z.enum(["public", "internal", "confidential", "privileged"]),
    writeScope: z.enum(["none", "isolated_repository"]),
    externalEffects: z.array(z.string().min(1).max(100)).max(20).default([]),
  })
  .strict();
const MESSAGE_INPUT = z.object({ message: z.string().min(1).max(8_000) }).strict();
const ROLLBACK_INPUT = z.object({ reason: z.string().min(1).max(500) }).strict();
const RETRY_INPUT = z.object({ reason: z.string().min(1).max(500) }).strict();
const WORKSPACE_INPUT = z
  .object({
    goalId: z.string().min(1).max(150),
    repositoryPath: z.string().min(1).max(2_000),
    baseRef: z.string().min(1).max(200),
    mode: z.enum(["read", "write"]),
    territoryPath: z.string().min(1).max(500),
    territoryTtlMs: z.number().int().min(30_000).max(3_600_000),
    checks: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            executable: z.string().min(1).max(100),
            arguments: z.array(z.string().max(500)).max(40),
            relativeCwd: z.string().max(500),
            timeoutMs: z.number().int().min(1_000).max(900_000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const APPROVAL_DECISION_INPUT = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().min(1).max(1_000),
  })
  .strict();
const IMPROVEMENT_INPUT = z
  .object({
    title: z.string().min(1).max(160),
    hypothesis: z.string().min(1).max(2_000),
    baseline: z.string().min(1).max(2_000),
    proposedChange: z.string().min(1).max(4_000),
    safetyMetric: z.string().min(1).max(1_000),
    evaluationPlan: z.string().min(1).max(2_000),
    sourceEventIds: z.array(z.string().min(1).max(150)).min(1).max(50),
  })
  .strict();
const IMPROVEMENT_TRANSITION_INPUT = z
  .object({
    state: z.enum(["sandboxed", "evaluated", "canary", "observing", "adopted", "rejected", "rolled_back"]),
    resultSummary: z.string().min(1).max(2_000),
    limitations: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();

export async function buildHttpServer(controlCenter: ControlCenter): Promise<FastifyInstance> {
  const server = Fastify({
    logger:
      controlCenter.config.environment === "test"
        ? false
        : {
            level: "info",
            redact: ["req.headers.cookie", "req.headers.authorization", "res.headers.set-cookie"],
          },
    bodyLimit: 1_100_000,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    routerOptions: { maxParamLength: 200 },
    trustProxy: false,
  });
  await server.register(cookie, {
    secret: controlCenter.config.sessionSecret.toString("base64url"),
    hook: "onRequest",
  });
  const auth = new LocalSessionAuth(controlCenter.config, controlCenter.store.database);

  server.addHook("onRequest", async (request, reply) => {
    auth.removeExpired();
    try {
      assertLoopbackHost(request.headers.host ?? "");
    } catch {
      throw new AuthenticationError("Request Host is not loopback");
    }
    const remoteAddress = request.socket.remoteAddress ?? request.ip;
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") {
      throw new AuthenticationError("Remote client is not loopback");
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  server.get("/api/health", async () => ({ status: "ok", safetyMode: "local_only" }));
  server.get("/api/session", async (_request, reply) => auth.create(reply));
  server.delete("/api/session", async (request, reply) => {
    auth.requireMutation(request);
    auth.revoke(request, reply);
    reply.status(204).send();
  });

  server.get("/api/snapshot", async (request) => {
    auth.requireSession(request);
    return controlCenter.snapshot();
  });
  server.get("/api/agents/:agentId", async (request) => {
    auth.requireSession(request);
    const { agentId } = AGENT_PARAMS.parse(request.params);
    return controlCenter.agentDetail(agentId);
  });
  server.post("/api/goals", async (request, reply) => {
    requireMutation(auth, request);
    const result = controlCenter.createOwnerGoal(GOAL_INPUT.parse(request.body));
    reply.status(201);
    return result;
  });
  server.post("/api/goals/:id/start", async (request) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    return controlCenter.startGoal(id);
  });
  server.post("/api/goals/:id/retry", async (request) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    const { reason } = RETRY_INPUT.parse(request.body);
    return controlCenter.retryGoal(id, reason);
  });
  server.post("/api/goals/:id/complete", async (request, reply) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    await controlCenter.completeGoal(id);
    reply.status(204).send();
  });
  server.post("/api/goals/:id/rollback", async (request, reply) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    const { reason } = ROLLBACK_INPUT.parse(request.body);
    await controlCenter.rollbackGoal(id, reason);
    reply.status(204).send();
  });
  server.post("/api/agents/:agentId/start", async (request) => {
    requireMutation(auth, request);
    const { agentId } = AGENT_PARAMS.parse(request.params);
    return controlCenter.startIdleAgent(agentId);
  });
  server.post("/api/agents/:agentId/message", async (request) => {
    requireMutation(auth, request);
    const { agentId } = AGENT_PARAMS.parse(request.params);
    const { message } = MESSAGE_INPUT.parse(request.body);
    return controlCenter.supervisor.sendInteractiveMessage(agentId, message);
  });
  server.post("/api/sessions/:id/interrupt", async (request, reply) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    await controlCenter.supervisor.interrupt(id);
    reply.status(204).send();
  });
  server.post("/api/sessions/:id/cancel", async (request, reply) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    await controlCenter.supervisor.cancel(id);
    reply.status(204).send();
  });
  server.post("/api/workspaces", async (request, reply) => {
    requireMutation(auth, request);
    const result = await controlCenter.createWorkspace(WORKSPACE_INPUT.parse(request.body));
    reply.status(201);
    return result;
  });
  server.post("/api/approvals/:id/decision", async (request) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    const input = APPROVAL_DECISION_INPUT.parse(request.body);
    return controlCenter.approvals.decide({
      approvalId: id,
      decidedBy: controlCenter.config.ownerAgentId,
      decision: input.decision,
      note: input.note,
    });
  });
  server.get("/api/improvements/:id/export", async (request, reply) => {
    auth.requireSession(request);
    const { id } = ID_PARAMS.parse(request.params);
    const review = controlCenter.store.getImprovementReview(id);
    reply.header("content-disposition", `attachment; filename="improvement-${id}.json"`);
    reply.header("cache-control", "no-store");
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      controllerVersion: CONTROLLER_VERSION,
      roleContractVersion: ROLE_CONTRACT_VERSION,
      review,
    };
  });
  server.post("/api/improvements", async (request, reply) => {
    requireMutation(auth, request);
    const result = controlCenter.createImprovementReview(IMPROVEMENT_INPUT.parse(request.body));
    reply.status(201);
    return result;
  });
  server.post("/api/improvements/:id/transition", async (request) => {
    requireMutation(auth, request);
    const { id } = ID_PARAMS.parse(request.params);
    const input = IMPROVEMENT_TRANSITION_INPUT.parse(request.body);
    return controlCenter.transitionImprovementReview({
      reviewId: id,
      ...input,
    });
  });
  server.get("/events", async (request, reply) => {
    auth.requireSession(request);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ generatedAt: new Date().toISOString() })}\n\n`);
    let heartbeat: NodeJS.Timeout | null = null;
    const unsubscribe = controlCenter.events.subscribe((event) => {
      if (event.kind === "shutdown") {
        if (heartbeat) clearInterval(heartbeat);
        reply.raw.end();
        return;
      }
      reply.raw.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
    });
    heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    reply.raw.once("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (existsSync(controlCenter.config.webDistPath)) {
    await server.register(fastifyStatic, {
      root: controlCenter.config.webDistPath,
      wildcard: false,
      decorateReply: true,
    });
    server.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  server.setNotFoundHandler(async (request, reply) => {
    reply.status(404).send({
      error: `No route for ${request.method} ${request.url}`,
      code: "not_found",
    } satisfies ApiErrorBody);
  });
  server.setErrorHandler(async (error, _request, reply) => {
    const safe = sanitizeError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof AuthenticationError
        ? 401
        : error instanceof ZodError
          ? 400
          : /unknown|not found/i.test(errorMessage)
            ? 404
            : /conflict|already|invalid|blocked|lease|active|cannot|must|not allowed|does not|mismatch/i.test(
                  errorMessage,
                )
              ? 409
              : 500;
    reply.status(status).send({
      error: safe.summary,
      code: error instanceof ZodError ? "invalid_request" : safe.code,
    } satisfies ApiErrorBody);
  });

  return server;
}

function requireMutation(auth: LocalSessionAuth, request: FastifyRequest): void {
  auth.requireMutation(request);
}
