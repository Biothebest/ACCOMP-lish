import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { OMP_MAX_FRAME_BYTES } from "./rpc-frame.js";

export interface ControllerConfig {
  projectRoot: string;
  organizationConfigPath: string;
  organizationName: string;
  ownerDisplayName: string;
  ompProfile: string;
  dataDir: string;
  databasePath: string;
  webDistPath: string;
  agentCommandsDir: string;
  host: "127.0.0.1" | "::1";
  port: number;
  ompPath: string;
  ompConfigPath: string;
  ownerAgentId: "OWNER-01";
  maxConcurrentSessions: number;
  staleSessionMs: number;
  ompRequestTimeoutMs: number;
  maxOmpFrameBytes: number;
  approvalTtlMs: number;
  sessionCookieTtlMs: number;
  sessionSecret: Buffer;
  environment: "development" | "production" | "test";
  fakeOmpAllowed: boolean;
}

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  "127.0.0.1": true,
  "::1": true,
};

const ORGANIZATION_CONFIG = z
  .object({
    schemaVersion: z.literal(2),
    organizationName: z.string().trim().min(1).max(80),
    ownerDisplayName: z.string().trim().min(1).max(80),
    ompProfile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  })
  .strict();

function readOrganizationConfig(path: string): z.infer<typeof ORGANIZATION_CONFIG> {
  if (!existsSync(path)) {
    throw new Error(`Organization configuration does not exist: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`Organization configuration is not valid JSON: ${path}`);
  }
  return ORGANIZATION_CONFIG.parse(value);
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function loadOrCreateSecret(dataDir: string): Buffer {
  const secretPath = join(dataDir, "controller-secret");
  if (existsSync(secretPath)) {
    const secret = readFileSync(secretPath);
    if (secret.length < 32) {
      throw new Error(`Controller secret is too short: ${secretPath}`);
    }
    return secret;
  }
  const secret = randomBytes(48);
  writeFileSync(secretPath, secret, { mode: 0o600, flag: "wx" });
  chmodSync(secretPath, 0o600);
  return secret;
}

function writeRestrictedOmpConfig(configPath: string): void {
  const content = [
    "disabledProviders:",
    "  - native",
    "  - claude",
    "  - codex",
    "  - gemini",
    "  - github",
    "  - opencode",
    "  - cursor",
    "  - agents-md",
    "mcp:",
    "  enableProjectConfig: false",
    "browser:",
    "  enabled: false",
    "compaction:",
    "  enabled: false",
    "retry:",
    "  enabled: false",
    "",
  ].join("\n");
  writeFileSync(configPath, content, { encoding: "utf-8", mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export function loadConfig(overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = overrides.projectRoot ?? resolve(moduleDirectory, "../..");
  const organizationConfigPath = resolve(
    overrides.organizationConfigPath ??
      process.env.OACC_ORGANIZATION_CONFIG ??
      join(projectRoot, "config", "organization.json"),
  );
  const fileOrganization =
    overrides.organizationName && overrides.ownerDisplayName
      ? {
          schemaVersion: 2 as const,
          organizationName: overrides.organizationName,
          ownerDisplayName: overrides.ownerDisplayName,
          ompProfile: overrides.ompProfile ?? "default",
        }
      : readOrganizationConfig(organizationConfigPath);
  const organization = ORGANIZATION_CONFIG.parse({
    ...fileOrganization,
    organizationName:
      overrides.organizationName ?? process.env.OACC_ORGANIZATION_NAME ?? fileOrganization.organizationName,
    ownerDisplayName:
      overrides.ownerDisplayName ?? process.env.OACC_OWNER_NAME ?? fileOrganization.ownerDisplayName,
    ompProfile: overrides.ompProfile ?? fileOrganization.ompProfile,
  });
  const dataDir = overrides.dataDir ?? resolve(process.env.OACC_DATA_DIR || join(projectRoot, ".data"));
  const requestedHost = overrides.host ?? process.env.OACC_HOST ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS[requestedHost]) {
    throw new Error(`OACC_HOST must be loopback-only; received ${requestedHost}`);
  }
  const host = requestedHost as ControllerConfig["host"];
  const environment =
    overrides.environment ??
    (process.env.NODE_ENV === "test"
      ? "test"
      : process.env.NODE_ENV === "development"
        ? "development"
        : "production");

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "workspaces"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "omp"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "tmp"), { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const ompConfigPath = overrides.ompConfigPath ?? join(dataDir, "omp", "restricted.yml");
  writeRestrictedOmpConfig(ompConfigPath);

  const trustedOmpPath = resolve(join(homedir(), ".local", "bin", "omp"));
  const ompPath = resolve(overrides.ompPath ?? process.env.OACC_OMP_PATH ?? trustedOmpPath);
  const fakeOmpAllowed = overrides.fakeOmpAllowed ?? environment === "test";
  if (fakeOmpAllowed && environment !== "test") {
    throw new Error("Fake OMP adapters are permitted only in the test environment");
  }
  if (!fakeOmpAllowed && ompPath !== trustedOmpPath) {
    throw new Error(`Production control center requires the trusted OMP binary at ${trustedOmpPath}`);
  }

  return {
    projectRoot,
    organizationConfigPath,
    organizationName: organization.organizationName,
    ownerDisplayName: organization.ownerDisplayName,
    ompProfile: organization.ompProfile,
    dataDir,
    databasePath: overrides.databasePath ?? join(dataDir, "control-center.sqlite3"),
    webDistPath: overrides.webDistPath ?? join(projectRoot, "dist-web"),
    agentCommandsDir: overrides.agentCommandsDir ?? join(projectRoot, "agents"),
    host,
    port: overrides.port ?? integerSetting("OACC_PORT", 4317, 1024, 65_535),
    ompPath,
    ompConfigPath,
    ownerAgentId: "OWNER-01",
    maxConcurrentSessions: overrides.maxConcurrentSessions ?? integerSetting("OACC_MAX_SESSIONS", 4, 1, 12),
    staleSessionMs:
      overrides.staleSessionMs ?? integerSetting("OACC_STALE_SESSION_MS", 60_000, 5_000, 900_000),
    ompRequestTimeoutMs:
      overrides.ompRequestTimeoutMs ?? integerSetting("OACC_OMP_REQUEST_TIMEOUT_MS", 20_000, 1_000, 120_000),
    maxOmpFrameBytes:
      overrides.maxOmpFrameBytes ??
      integerSetting("OACC_MAX_OMP_FRAME_BYTES", OMP_MAX_FRAME_BYTES, 1_024, OMP_MAX_FRAME_BYTES),
    approvalTtlMs:
      overrides.approvalTtlMs ?? integerSetting("OACC_APPROVAL_TTL_MS", 900_000, 60_000, 86_400_000),
    sessionCookieTtlMs:
      overrides.sessionCookieTtlMs ?? integerSetting("OACC_COOKIE_TTL_MS", 43_200_000, 300_000, 86_400_000),
    sessionSecret: overrides.sessionSecret ?? loadOrCreateSecret(dataDir),
    environment,
    fakeOmpAllowed,
  };
}
