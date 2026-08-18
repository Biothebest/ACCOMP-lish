import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const executeFile = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const CORE_ROOT = resolve(moduleDirectory, "..");
export const PRODUCT_NAME = "ACCOMP-lish";
export const REGISTRY_SCHEMA_VERSION = 1;
const FIRST_PROJECT_PORT = 4317;
const LAST_PROJECT_PORT = 4917;
const LABEL = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
      }),
    "Label contains a control character",
  );

const IDENTIFIER = /^[a-f0-9]{16}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT_RECORD = z
  .object({
    projectId: z.string().regex(IDENTIFIER),
    name: LABEL,
    repositoryRoot: z.string().min(1).max(2_000),
    ownerDisplayName: LABEL,
    ompProfile: z.string().regex(PROFILE),
    port: z.number().int().min(1_024).max(65_535),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const REGISTRY = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    projects: z.array(PROJECT_RECORD).max(1_000),
  })
  .strict();
const RUNTIME = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(IDENTIFIER),
    instanceId: z.string().uuid(),
    processId: z.number().int().positive(),
    port: z.number().int().min(1_024).max(65_535),
    startedAt: z.string().datetime(),
  })
  .strict();
const HEALTH = z
  .object({
    status: z.literal("ok"),
    productName: z.literal(PRODUCT_NAME),
    version: z.string().min(1),
    safetyMode: z.literal("local_only"),
    projectId: z.string().min(1).max(128),
    organizationName: z.string().min(1).max(80),
    processId: z.number().int().positive(),
    instanceId: z.string().min(1).max(128),
    port: z.number().int().min(1_024).max(65_535),
  })
  .strict();

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function defaultAccomplishHome(environment = process.env, userHome = homedir()) {
  return resolve(
    environment.ACCOMPLISH_HOME || join(userHome, "Library", "Application Support", PRODUCT_NAME),
  );
}

export function projectIdentifier(repositoryRoot) {
  return createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16);
}

export function projectPaths(home, projectId) {
  if (!IDENTIFIER.test(projectId)) {
    throw new Error("Project ID must be a 16-character lowercase hexadecimal digest");
  }
  const capsuleDirectory = join(resolve(home), "projects", projectId);
  return {
    capsuleDirectory,
    configPath: join(capsuleDirectory, "organization.json"),
    dataDirectory: join(capsuleDirectory, "state"),
    runtimePath: join(capsuleDirectory, "runtime.json"),
    logPath: join(capsuleDirectory, "controller.log"),
  };
}

function registryPath(home) {
  return join(resolve(home), "registry.json");
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeJsonAtomic(path, value) {
  await ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function readJson(path, schema, missingValue) {
  let content;
  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    if (error?.code === "ENOENT") return missingValue;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON: ${path}`);
  }
  return schema.parse(parsed);
}

async function readRegistry(home) {
  return readJson(registryPath(home), REGISTRY, {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    projects: [],
  });
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function acquireOwnedLock(path, description) {
  await ensurePrivateDirectory(dirname(path));
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      const handle = await openFile(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ processId: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      return async () => {
        await handle.close();
        await unlink(path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(await readFile(path, "utf-8"));
        if (!Number.isInteger(lock.processId) || !processIsAlive(lock.processId)) {
          await unlink(path);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
      }
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for the ACCOMP-lish ${description} lock`);
}

async function withOwnedLock(path, description, operation) {
  const release = await acquireOwnedLock(path, description);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withRegistryLock(home, operation) {
  return withOwnedLock(join(resolve(home), "registry.lock"), "project registry", operation);
}

async function withProjectLifecycleLock(project, operation) {
  return withOwnedLock(join(project.capsuleDirectory, "lifecycle.lock"), "project lifecycle", operation);
}

export async function canonicalRepositoryRoot(cwd = process.cwd()) {
  let stdout;
  try {
    ({ stdout } = await executeFile("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    }));
  } catch {
    throw new Error(`No Git project found from ${resolve(cwd)}`);
  }
  const discovered = stdout.trim();
  if (!discovered) throw new Error(`Git returned no project root from ${resolve(cwd)}`);
  return realpath(discovered);
}

function hydrateProject(home, record) {
  return {
    ...record,
    ...projectPaths(home, record.projectId),
    url: `http://127.0.0.1:${record.port}/`,
  };
}

async function portIsAvailable(port) {
  return new Promise((resolveAvailability) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailability(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolveAvailability(true));
    });
  });
}

async function choosePort(projects, requestedPort) {
  const occupied = new Set(projects.map((project) => project.port));
  if (requestedPort !== undefined) {
    if (!Number.isInteger(requestedPort) || requestedPort < 1_024 || requestedPort > 65_535) {
      throw new Error("Project port must be an integer from 1024 through 65535");
    }
    if (occupied.has(requestedPort) || !(await portIsAvailable(requestedPort))) {
      throw new Error(`Project port ${requestedPort} is unavailable`);
    }
    return requestedPort;
  }
  for (let port = FIRST_PROJECT_PORT; port <= LAST_PROJECT_PORT; port += 1) {
    if (!occupied.has(port) && (await portIsAvailable(port))) return port;
  }
  throw new Error("No ACCOMP-lish project port is available");
}

export async function initializeProject(options = {}) {
  const home = resolve(options.home ?? defaultAccomplishHome());
  const repositoryRoot = await canonicalRepositoryRoot(options.cwd ?? process.cwd());
  const projectId = projectIdentifier(repositoryRoot);
  const name = LABEL.parse(options.name ?? basename(repositoryRoot));
  const ownerDisplayName = LABEL.parse(
    options.ownerDisplayName ?? process.env.ACCOMPLISH_OWNER_NAME ?? "Owner",
  );
  const ompProfile = options.ompProfile ?? process.env.OMP_PROFILE ?? "default";
  if (!PROFILE.test(ompProfile)) {
    throw new Error("OMP profile must contain 1–64 letters, digits, dots, underscores, or hyphens");
  }
  const now = (options.now ?? new Date()).toISOString();

  return withRegistryLock(home, async () => {
    const registry = await readRegistry(home);
    const existingIndex = registry.projects.findIndex(
      (project) => project.projectId === projectId || project.repositoryRoot === repositoryRoot,
    );
    const existing = existingIndex >= 0 ? registry.projects[existingIndex] : null;
    const port = existing?.port ?? (await choosePort(registry.projects, options.port));
    if (existing && options.port !== undefined && options.port !== existing.port) {
      throw new Error(`Project already owns stable port ${existing.port}`);
    }
    const record = PROJECT_RECORD.parse({
      projectId,
      name,
      repositoryRoot,
      ownerDisplayName,
      ompProfile,
      port,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const paths = projectPaths(home, projectId);
    await ensurePrivateDirectory(paths.capsuleDirectory);
    await ensurePrivateDirectory(paths.dataDirectory);
    await writeJsonAtomic(paths.configPath, {
      schemaVersion: 2,
      organizationName: record.name,
      ownerDisplayName: record.ownerDisplayName,
      ompProfile: record.ompProfile,
    });
    if (existingIndex >= 0) registry.projects[existingIndex] = record;
    else registry.projects.push(record);
    registry.projects.sort((left, right) => left.name.localeCompare(right.name));
    await writeJsonAtomic(registryPath(home), REGISTRY.parse(registry));
    return hydrateProject(home, record);
  });
}

export async function listProjects(options = {}) {
  const home = resolve(options.home ?? defaultAccomplishHome());
  const registry = await readRegistry(home);
  return registry.projects.map((record) => hydrateProject(home, record));
}

export async function resolveProject(options = {}) {
  const home = resolve(options.home ?? defaultAccomplishHome());
  const projects = await listProjects({ home });
  if (options.projectId) {
    const selected = projects.find((project) => project.projectId === options.projectId);
    if (!selected) throw new Error(`Unknown ACCOMP-lish project: ${options.projectId}`);
    return selected;
  }
  const repositoryRoot = await canonicalRepositoryRoot(options.cwd ?? process.cwd());
  const projectId = projectIdentifier(repositoryRoot);
  const selected = projects.find(
    (project) => project.projectId === projectId && project.repositoryRoot === repositoryRoot,
  );
  if (!selected) {
    throw new Error(`Project is not initialized. Run accomplish init from ${repositoryRoot}`);
  }
  return selected;
}

async function readRuntime(project) {
  return readJson(project.runtimePath, RUNTIME, null);
}

async function probeHealth(project, timeoutMs = 1_000) {
  try {
    const response = await fetch(`${project.url}api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return HEALTH.parse(await response.json());
  } catch {
    return null;
  }
}

function healthMatchesRuntime(project, runtime, health) {
  return Boolean(
    runtime &&
      health &&
      health.projectId === project.projectId &&
      health.instanceId === runtime.instanceId &&
      health.processId === runtime.processId &&
      health.port === project.port,
  );
}

export async function projectStatus(project, options = {}) {
  const runtime = await readRuntime(project);
  const health = await probeHealth(project, options.healthTimeoutMs);
  if (healthMatchesRuntime(project, runtime, health)) {
    return { state: "running", project, runtime, health };
  }
  if (health) {
    return { state: "port_conflict", project, runtime, health };
  }
  if (!runtime) return { state: "stopped", project, runtime: null, health: null };
  if (processIsAlive(runtime.processId)) {
    return { state: "unverified_process", project, runtime, health: null };
  }
  return { state: "stale", project, runtime, health: null };
}

async function waitForMatchingHealth(project, runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(project, 500);
    if (healthMatchesRuntime(project, runtime, health)) return health;
    if (health) throw new Error(`Port ${project.port} is serving a different controller instance`);
    if (!processIsAlive(runtime.processId)) {
      throw new Error("ACCOMP-lish controller exited before becoming healthy");
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the ACCOMP-lish controller health check");
}

async function startProjectUnlocked(project, options = {}) {
  const current = await projectStatus(project, options);
  if (current.state === "running") return current;
  if (current.state === "port_conflict") {
    throw new Error(`Port ${project.port} is owned by another local service`);
  }
  if (current.state === "unverified_process") {
    throw new Error("A recorded controller process is alive but its identity cannot be verified");
  }
  if (current.state === "stale") await rm(project.runtimePath, { force: true });

  const coreRoot = resolve(options.coreRoot ?? CORE_ROOT);
  const serverEntry = resolve(options.serverEntry ?? join(coreRoot, "dist-server", "server", "index.js"));
  try {
    await lstat(serverEntry);
  } catch {
    throw new Error(`Built ACCOMP-lish server is missing: ${serverEntry}. Run npm run build.`);
  }

  await ensurePrivateDirectory(project.capsuleDirectory);
  await ensurePrivateDirectory(project.dataDirectory);
  const logHandle = await openFile(project.logPath, "a", 0o600);
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: coreRoot,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env: {
      ...process.env,
      NODE_ENV: "production",
      ACCOMPLISH_ORGANIZATION_CONFIG: project.configPath,
      ACCOMPLISH_ORGANIZATION_NAME: project.name,
      ACCOMPLISH_OWNER_NAME: project.ownerDisplayName,
      ACCOMPLISH_DATA_DIR: project.dataDirectory,
      ACCOMPLISH_PORT: String(project.port),
      ACCOMPLISH_PROJECT_ID: project.projectId,
      ACCOMPLISH_REPOSITORY_ROOT: project.repositoryRoot,
      ACCOMPLISH_INSTANCE_ID: instanceId,
    },
  });
  await logHandle.close();
  if (!child.pid) throw new Error("ACCOMP-lish controller did not return a process ID");
  child.unref();
  const runtime = RUNTIME.parse({
    schemaVersion: 1,
    projectId: project.projectId,
    instanceId,
    processId: child.pid,
    port: project.port,
    startedAt: new Date().toISOString(),
  });
  await writeJsonAtomic(project.runtimePath, runtime);
  try {
    const health = await waitForMatchingHealth(project, runtime, options.startTimeoutMs ?? 20_000);
    return { state: "running", project, runtime, health };
  } catch (error) {
    if (processIsAlive(runtime.processId)) process.kill(runtime.processId, "SIGTERM");
    await rm(project.runtimePath, { force: true });
    throw error;
  }
}

export async function startProject(project, options = {}) {
  return withProjectLifecycleLock(project, () => startProjectUnlocked(project, options));
}

async function waitForProcessExit(processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(processId)) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for the ACCOMP-lish controller to stop");
}

async function stopProjectUnlocked(project, options = {}) {
  const current = await projectStatus(project, options);
  if (current.state === "stopped") return current;
  if (current.state === "stale") {
    await rm(project.runtimePath, { force: true });
    return { ...current, state: "stopped", runtime: null };
  }
  if (current.state !== "running") {
    throw new Error("Refusing to stop a process whose ACCOMP-lish identity is not verified");
  }
  process.kill(current.runtime.processId, "SIGTERM");
  await waitForProcessExit(current.runtime.processId, options.stopTimeoutMs ?? 15_000);
  await rm(project.runtimePath, { force: true });
  return { state: "stopped", project, runtime: null, health: null };
}

export async function stopProject(project, options = {}) {
  return withProjectLifecycleLock(project, () => stopProjectUnlocked(project, options));
}

export function buildTaskUrl(project, input) {
  const task = z.string().trim().min(1).max(160).parse(input.task);
  const description = z.string().trim().min(1).max(4_000).parse(input.description);
  const outcome = z.string().trim().min(1).max(500).parse(input.outcome);
  const url = new URL(project.url);
  const parameters = new URLSearchParams();
  parameters.set("accomplish", "1");
  parameters.set("task", task);
  parameters.set("description", description);
  parameters.set("outcome", outcome);
  url.hash = parameters.toString();
  return url.toString();
}

export async function openUrl(url, options = {}) {
  if (options.noOpen) return;
  const opener = options.opener ?? "/usr/bin/open";
  await executeFile(opener, [url], { timeout: 10_000 });
}

export async function prepareTask(project, input, options = {}) {
  const status = await startProject(project, options);
  const url = buildTaskUrl(project, input);
  await openUrl(url, options);
  return { project, status, url };
}

export async function installGlobalCommand(options = {}) {
  const binDirectory = resolve(options.binDirectory ?? join(homedir(), ".local", "bin"));
  const sourcePath = await realpath(options.sourcePath ?? join(CORE_ROOT, "scripts", "accomplish.mjs"));
  const targetPath = join(binDirectory, "accomplish");
  await ensurePrivateDirectory(binDirectory);
  let targetStats;
  try {
    targetStats = await lstat(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await symlink(sourcePath, targetPath);
    return { targetPath, sourcePath, installed: true };
  }
  if (!targetStats.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-symlink command: ${targetPath}`);
  }
  const existingLink = await readlink(targetPath);
  const linkedPath = isAbsolute(existingLink) ? existingLink : resolve(dirname(targetPath), existingLink);
  let existingTarget;
  try {
    existingTarget = await realpath(linkedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Refusing to replace a broken accomplish command: ${targetPath}`);
    }
    throw error;
  }
  if (existingTarget === sourcePath) return { targetPath, sourcePath, installed: false };
  throw new Error(`Refusing to replace a different accomplish command: ${targetPath}`);
}
