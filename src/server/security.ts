import { createHash, timingSafeEqual } from "node:crypto";

const SENSITIVE_KEY_PATTERN =
  /(?:secret|password|credential|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|system[_-]?prompt|thinking[_-]?delta|reasoning[_-]?delta|raw[_-]?(?:frame|payload|output)|full[_-]?environment)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["']?[^\s,"']{6,}/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const LONG_OPAQUE_PATTERN = /\b[A-Za-z0-9+/=_-]{64,}\b/g;
const PROTECTED_ASSISTANT_PATTERN =
  /(?:<system(?:-|_)?(?:directive|message|prompt)?\b|system prompt|hidden (?:instructions|reasoning|scratchpad)|chain[- ]of[- ]thought|OMP_AUTH_|BEGIN (?:SYSTEM|PRIVATE)|full environment|\.omp\/(?:auth|secrets|credentials))/i;
const PUBLIC_DIGEST_KEYS = new Set([
  "artifactHash",
  "artifact_hash",
  "artifactIdentity",
  "artifact_identity",
  "candidateIdentity",
  "candidate_identity",
  "baseRevision",
  "currentRevision",
]);

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonValue(value, new WeakSet<object>());
}

function canonicalJsonValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("Value is not JSON-serializable");
    }
    return encoded;
  }
  if (ancestors.has(value)) {
    throw new Error("Cyclic value is not JSON-serializable");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJsonValue(item, ancestors)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeText(value: string, maximumLength = 2_000): string {
  const redacted = value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(KEY_ASSIGNMENT_PATTERN, "[REDACTED_CREDENTIAL]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED_OPENAI_KEY]")
    .replace(LONG_OPAQUE_PATTERN, "[REDACTED_OPAQUE_VALUE]")
    .replaceAll("\u0000", "");
  return redacted.length <= maximumLength ? redacted : `${redacted.slice(0, maximumLength)}…`;
}

export function sanitizeAssistantOutput(value: string): string {
  const sanitized = sanitizeText(value, 20_000);
  if (PROTECTED_ASSISTANT_PATTERN.test(sanitized)) {
    return "[REDACTED: assistant output matched protected prompt, reasoning, or environment material]";
  }
  return sanitized;
}

export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) {
    return "[TRUNCATED_DEPTH]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeText(value, 1_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (
      PUBLIC_DIGEST_KEYS.has(key) &&
      typeof item === "string" &&
      /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(item)
    ) {
      sanitized[key] = item.toLowerCase();
      continue;
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = sanitizeMetadata(item, depth + 1);
  }
  return sanitized;
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertLoopbackHost(host: string): void {
  const value = host.trim().toLowerCase();
  if (value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]") {
    return;
  }
  const match =
    /^(?:127\.0\.0\.1|localhost):([0-9]{1,5})$/.exec(value) ?? /^\[::1\]:([0-9]{1,5})$/.exec(value);
  const port = match ? Number(match[1]) : 0;
  if (!match || port < 1 || port > 65_535) {
    throw new Error("Request host is not loopback");
  }
}

export function sanitizeError(error: unknown): { code: string; summary: string } {
  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      summary: sanitizeText(error.message, 500),
    };
  }
  return { code: "UnknownError", summary: sanitizeText(String(error), 500) };
}
