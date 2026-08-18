import { randomBytes } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiSession } from "../shared/contracts.js";
import type { ControllerConfig } from "./config.js";
import { safeEqual, sha256 } from "./security.js";

const COOKIE_NAME = "accomplish_session";

export class LocalSessionAuth {
  constructor(
    private readonly config: ControllerConfig,
    private readonly database: DatabaseType,
  ) {
    this.removeExpired();
  }

  create(reply: FastifyReply): ApiSession {
    this.removeExpired();
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.config.sessionCookieTtlMs;
    this.database
      .prepare(
        "INSERT INTO api_sessions (session_hash, csrf_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sha256(sessionId), sha256(csrfToken), new Date(expiresAt).toISOString(), new Date().toISOString());
    reply.setCookie(COOKIE_NAME, sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      signed: true,
      maxAge: Math.floor(this.config.sessionCookieTtlMs / 1_000),
    });
    return { csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  requireSession(request: FastifyRequest): string {
    const signedCookie = request.cookies[COOKIE_NAME];
    if (!signedCookie) {
      throw new AuthenticationError("Local owner session is required");
    }
    const unsigned = request.unsignCookie(signedCookie);
    if (!unsigned.valid || !unsigned.value) {
      throw new AuthenticationError("Local owner session cookie is invalid");
    }
    const sessionHash = sha256(unsigned.value);
    const record = this.database
      .prepare(
        "SELECT csrf_hash AS csrfHash, expires_at AS expiresAt FROM api_sessions WHERE session_hash = ?",
      )
      .get(sessionHash) as { csrfHash: string; expiresAt: string } | undefined;
    if (!record || Date.parse(record.expiresAt) <= Date.now()) {
      this.database.prepare("DELETE FROM api_sessions WHERE session_hash = ?").run(sessionHash);
      throw new AuthenticationError("Local owner session expired");
    }
    return unsigned.value;
  }

  requireMutation(request: FastifyRequest): void {
    const sessionId = this.requireSession(request);
    const csrfToken = request.headers["x-csrf-token"];
    if (typeof csrfToken !== "string") {
      throw new AuthenticationError("CSRF token is required");
    }
    const record = this.database
      .prepare("SELECT csrf_hash AS csrfHash FROM api_sessions WHERE session_hash = ?")
      .get(sha256(sessionId)) as { csrfHash: string } | undefined;
    if (!record || !safeEqual(record.csrfHash, sha256(csrfToken))) {
      throw new AuthenticationError("CSRF token is invalid");
    }
    const origin = request.headers.origin;
    if (origin) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new AuthenticationError("Request origin is invalid");
      }
      if (
        url.protocol !== "http:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")
      ) {
        throw new AuthenticationError("Mutation origin is not loopback");
      }
    }
  }

  revoke(request: FastifyRequest, reply: FastifyReply): void {
    const signedCookie = request.cookies[COOKIE_NAME];
    if (signedCookie) {
      const unsigned = request.unsignCookie(signedCookie);
      if (unsigned.valid && unsigned.value) {
        this.database.prepare("DELETE FROM api_sessions WHERE session_hash = ?").run(sha256(unsigned.value));
      }
    }
    reply.clearCookie(COOKIE_NAME, { path: "/" });
  }

  removeExpired(): number {
    return this.database
      .prepare("DELETE FROM api_sessions WHERE expires_at <= ?")
      .run(new Date().toISOString()).changes;
  }
}

export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}
