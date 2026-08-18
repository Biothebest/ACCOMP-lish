import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ControllerConfig } from "./config.js";
import { canonicalJson, sanitizeError, sanitizeText, sha256 } from "./security.js";
import type { ControlStore } from "./store.js";
import type { WorkspaceManager } from "./workspaces.js";

const executeFile = promisify(execFile);
const ALLOWED_EXECUTABLES: Readonly<Record<string, true>> = {
  node: true,
  npm: true,
  python: true,
  python3: true,
  pytest: true,
  ruff: true,
  tsc: true,
  vitest: true,
};
const PROHIBITED_ARGUMENT_PATTERN =
  /(?:^|[\s=])(?:push|deploy|publish|release|upload|curl|wget|ssh|scp)(?:$|[\s=])|https?:\/\//i;
const MAX_CHECK_OUTPUT_BYTES = 200_000;

export class CheckRunner {
  constructor(
    private readonly store: ControlStore,
    private readonly workspaces: WorkspaceManager,
    private readonly config: ControllerConfig,
  ) {}

  register(input: {
    workspaceId: string;
    label: string;
    executable: string;
    arguments: string[];
    relativeCwd: string;
    timeoutMs: number;
  }): string {
    const executableName = basename(input.executable);
    if (
      !ALLOWED_EXECUTABLES[executableName] ||
      input.executable.includes("/") ||
      input.executable.includes("\\")
    ) {
      throw new Error(`Check executable is not allowlisted: ${input.executable}`);
    }
    if (
      input.arguments.length > 40 ||
      input.arguments.some((argument) => argument.length > 500 || PROHIBITED_ARGUMENT_PATTERN.test(argument))
    ) {
      throw new Error("Check arguments contain a prohibited command, URL, or oversized value");
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 900_000) {
      throw new Error("Check timeout must be from one second through fifteen minutes");
    }
    const workspace = this.workspaces.getWorkspace(input.workspaceId);
    const relativeCwd = input.relativeCwd.trim().replaceAll("\\", "/").replace(/^\.\//, "") || ".";
    if (relativeCwd === ".." || relativeCwd.startsWith("../") || relativeCwd.startsWith("/")) {
      throw new Error("Check working directory must remain inside the workspace");
    }
    const checkId = `check-${randomUUID()}`;
    this.store.database
      .prepare(`
        INSERT INTO check_definitions (
          check_id, workspace_id, label, executable, arguments_json, relative_cwd, timeout_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        checkId,
        input.workspaceId,
        sanitizeText(input.label, 120),
        executableName,
        JSON.stringify(input.arguments),
        relativeCwd,
        input.timeoutMs,
        new Date().toISOString(),
      );
    this.store.recordEvent({
      type: "check.registered",
      summary: `Check registered: ${input.label}`,
      agentId: workspace.agentId,
      goalId: workspace.goalId,
      metadata: { checkId, executable: executableName, arguments: input.arguments },
    });
    return checkId;
  }

  async run(input: { checkId: string; agentId: string; workspaceAgentId?: string; goalId: string }): Promise<{
    checkRunId: string;
    result: "pass" | "fail" | "timeout" | "error";
    exitCode: number | null;
    outputSummary: string;
    candidateIdentity: string;
  }> {
    const definition = this.store.database
      .prepare(`
        SELECT check_id AS checkId, workspace_id AS workspaceId, label, executable,
          arguments_json AS argumentsJson, relative_cwd AS relativeCwd, timeout_ms AS timeoutMs
        FROM check_definitions WHERE check_id = ?
      `)
      .get(input.checkId) as CheckDefinitionRow | undefined;
    if (!definition) {
      throw new Error(`Unknown check definition: ${input.checkId}`);
    }
    const workspace = this.workspaces.getWorkspace(definition.workspaceId);
    if (
      workspace.agentId !== (input.workspaceAgentId ?? input.agentId) ||
      workspace.goalId !== input.goalId ||
      workspace.state === "released"
    ) {
      throw new Error("Check definition does not belong to the active agent goal workspace");
    }
    const arguments_: unknown = JSON.parse(definition.argumentsJson);
    if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
      throw new Error("Stored check arguments are invalid");
    }
    const cwd = await realpath(resolve(workspace.worktreePath, definition.relativeCwd));
    if (cwd !== workspace.worktreePath && !cwd.startsWith(`${workspace.worktreePath}${sep}`)) {
      throw new Error("Check working directory escaped the workspace");
    }
    const executablePath = await resolveExecutable(definition.executable);
    const runtimeRoots = new Set<string>([
      runtimeReadRoot(executablePath),
      runtimeReadRoot(await resolveExecutable("node")),
    ]);
    const temporaryDirectory = await mkdtemp(join(this.config.dataDir, "tmp", "check-"));
    const readableRoots = [
      workspace.worktreePath,
      temporaryDirectory,
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/Library",
      "/private/var/db/timezone",
      ...runtimeRoots,
    ];
    const profile = [
      "(version 1)",
      "(deny default)",
      '(import "system.sb")',
      "(allow process*)",
      "(allow sysctl-read)",
      '(allow file-read* (literal "/private/etc/localtime"))',
      ...readableRoots.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
      `(allow file-write* (subpath ${JSON.stringify(temporaryDirectory)}))`,
      "(deny network*)",
    ].join("\n");
    const startedAt = new Date().toISOString();
    let result: "pass" | "fail" | "timeout" | "error" = "error";
    let exitCode: number | null = null;
    let outputSummary = "Check did not start";
    try {
      const completed = await executeFile(
        "/usr/bin/sandbox-exec",
        ["-p", profile, executablePath, ...(arguments_ as string[])],
        {
          cwd,
          encoding: "utf-8",
          timeout: definition.timeoutMs,
          maxBuffer: MAX_CHECK_OUTPUT_BYTES,
          env: {
            PATH: process.env.PATH,
            HOME: temporaryDirectory,
            TMPDIR: temporaryDirectory,
            CI: "1",
            NO_COLOR: "1",
            PYTHONDONTWRITEBYTECODE: "1",
            npm_config_audit: "false",
            npm_config_fund: "false",
            npm_config_offline: "true",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      exitCode = 0;
      result = "pass";
      outputSummary = sanitizeText(
        `${completed.stdout}\n${completed.stderr}`.trim() || "Check passed with no output",
        8_000,
      );
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      exitCode = typeof processError.code === "number" ? processError.code : null;
      result =
        processError.killed || processError.code === "ETIMEDOUT"
          ? "timeout"
          : exitCode === null
            ? "error"
            : "fail";
      outputSummary = sanitizeText(
        `${processError.message}\n${processError.stdout ?? ""}\n${processError.stderr ?? ""}`,
        8_000,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    const candidateIdentity = await this.computeCandidateIdentity(workspace.worktreePath);
    const checkRunId = `check-run-${randomUUID()}`;
    const endedAt = new Date().toISOString();
    this.store.database
      .prepare(`
        INSERT INTO check_runs (
          check_run_id, check_id, goal_id, agent_id, candidate_identity, result,
          exit_code, output_summary, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        checkRunId,
        definition.checkId,
        input.goalId,
        input.agentId,
        candidateIdentity,
        result,
        exitCode,
        outputSummary,
        startedAt,
        endedAt,
      );
    this.store.recordEvent({
      type: `check.${result}`,
      summary: `${definition.label}: ${result}`,
      severity: result === "pass" ? "info" : "error",
      agentId: input.agentId,
      goalId: input.goalId,
      metadata: { checkRunId, checkId: definition.checkId, candidateIdentity, exitCode },
    });
    return { checkRunId, result, exitCode, outputSummary, candidateIdentity };
  }

  async computeCandidateIdentity(worktreePath: string): Promise<string> {
    const root = await realpath(worktreePath);
    const manifest: Array<{ path: string; size: number; digest: string }> = [];
    let totalBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        if (entry.isSymbolicLink()) {
          throw new Error("Candidate identity rejects symbolic links");
        }
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const fileStats = await stat(absolutePath);
        totalBytes += fileStats.size;
        if (manifest.length >= 20_000 || totalBytes > 256 * 1_048_576) {
          throw new Error("Workspace exceeds candidate identity limits");
        }
        const content = await readFile(absolutePath);
        manifest.push({
          path: relative(root, absolutePath).split(sep).join("/"),
          size: fileStats.size,
          digest: sha256(content),
        });
      }
    };
    await visit(root);
    manifest.sort((left, right) => left.path.localeCompare(right.path));
    return sha256(canonicalJson(manifest));
  }

  async assertCurrentCandidate(goalId: string): Promise<void> {
    const goal = this.store.getGoal(goalId);
    if (goal.writeScope !== "isolated_repository" || !goal.artifactIdentity) {
      return;
    }
    const workspace = this.store
      .listWorkspaces()
      .find(
        (item) =>
          item.goalId === goalId &&
          item.agentId === goal.ownerAgentId &&
          ["ready", "dirty"].includes(item.state),
      );
    if (!workspace) {
      throw new Error("Exact candidate evaluation requires its active controller-owned workspace");
    }
    let actualIdentity: string;
    let invalidationReason = "Final controller evaluation detected candidate drift";
    try {
      actualIdentity = await this.computeCandidateIdentity(workspace.worktreePath);
    } catch (error) {
      invalidationReason = `Final candidate recomputation failed: ${sanitizeError(error).summary}`;
      actualIdentity = "";
    }
    if (actualIdentity === goal.artifactIdentity) {
      return;
    }
    this.store.invalidateArtifact(goalId, this.config.ownerAgentId, invalidationReason);
    if (["queued", "running", "waiting_input", "waiting_approval", "verifying"].includes(goal.state)) {
      this.store.transitionGoal(
        goalId,
        "blocked",
        "Candidate changed or could not be revalidated; prior authority was invalidated",
        this.config.ownerAgentId,
      );
    }
    throw new Error(
      "Candidate changed or could not be revalidated after checks or approval; exact-artifact authority was invalidated",
    );
  }
}

async function resolveExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next exact PATH entry.
    }
  }
  throw new Error(`Check executable is not installed on the controller PATH: ${name}`);
}

function runtimeReadRoot(executablePath: string): string {
  const segments = resolve(executablePath).split(sep);
  const hermesIndex = segments.indexOf(".hermes");
  if (hermesIndex >= 0 && segments[hermesIndex + 1]) {
    return join(sep, ...segments.slice(1, hermesIndex + 2));
  }
  for (const marker of [".venv", "node_modules"]) {
    const markerIndex = segments.indexOf(marker);
    if (markerIndex >= 0) {
      return join(sep, ...segments.slice(1, markerIndex + 1));
    }
  }
  return dirname(executablePath);
}

interface CheckDefinitionRow {
  checkId: string;
  workspaceId: string;
  label: string;
  executable: string;
  argumentsJson: string;
  relativeCwd: string;
  timeoutMs: number;
}
