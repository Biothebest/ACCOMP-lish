import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceInspection, WorkspaceMode, WorkspaceSummary } from "../shared/contracts.js";
import type { ControllerConfig } from "./config.js";
import { sanitizeText } from "./security.js";
import type { ControlStore } from "./store.js";

const executeFile = promisify(execFile);
const MAX_READ_BYTES = 1_048_576;
const MAX_WRITE_BYTES = 1_048_576;
const MAX_SEARCH_FILES = 2_000;

interface GitResult {
  stdout: string;
  stderr: string;
}

export class WorkspaceManager {
  constructor(
    private readonly store: ControlStore,
    private readonly config: ControllerConfig,
  ) {}

  async createIsolatedWorktree(input: {
    goalId: string;
    agentId: string;
    repositoryPath: string;
    baseRef: string;
    mode: WorkspaceMode;
    integrationOwnerAgentId: string;
  }): Promise<WorkspaceSummary> {
    const existing = this.store
      .listWorkspaces()
      .find(
        (workspace) => workspace.agentId === input.agentId && ["ready", "dirty"].includes(workspace.state),
      );
    if (existing) {
      throw new Error(
        `Agent ${input.agentId} already owns active workspace ${existing.workspaceId} for goal ${existing.goalId}`,
      );
    }
    const repositoryRoot = await this.resolveRepositoryRoot(input.repositoryPath);
    const goal = this.store.getGoal(input.goalId);
    if (goal.ownerAgentId !== input.agentId) {
      throw new Error("Workspace agent must own the goal");
    }
    const baseRevision = (
      await this.git(repositoryRoot, ["rev-parse", "--verify", `${input.baseRef}^{commit}`])
    ).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(baseRevision)) {
      throw new Error("Git returned an invalid base revision");
    }

    const workspaceId = `workspace-${randomUUID()}`;
    const worktreePath = join(this.config.dataDir, "workspaces", workspaceId);
    await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
    await this.git(repositoryRoot, ["worktree", "add", "--detach", worktreePath, baseRevision]);
    const canonicalWorktreePath = await realpath(worktreePath);
    const currentRevision = (await this.git(canonicalWorktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const createdAt = new Date().toISOString();
    try {
      this.store.database.transaction(() => {
        this.store.database
          .prepare(`
            INSERT INTO workspaces (
              workspace_id, goal_id, agent_id, repository_root, worktree_path, base_revision,
              current_revision, mode, state, integration_owner_agent_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
          `)
          .run(
            workspaceId,
            input.goalId,
            input.agentId,
            repositoryRoot,
            canonicalWorktreePath,
            baseRevision,
            currentRevision,
            input.mode,
            input.integrationOwnerAgentId,
            createdAt,
          );
        this.store.database
          .prepare("UPDATE agents SET current_workspace_id = ? WHERE agent_id = ?")
          .run(workspaceId, input.agentId);
      })();
    } catch (error) {
      try {
        await this.git(repositoryRoot, ["worktree", "remove", "--force", canonicalWorktreePath]);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Workspace registration failed and the detached worktree could not be removed",
        );
      }
      throw error;
    }
    this.store.recordEvent({
      type: "workspace.created",
      summary: `Isolated ${input.mode} worktree created at ${baseRevision.slice(0, 12)}`,
      agentId: input.agentId,
      goalId: input.goalId,
      metadata: { workspaceId, repositoryRoot, baseRevision, mode: input.mode },
    });
    return this.getWorkspace(workspaceId);
  }

  async releaseWorkspace(workspaceId: string, actorAgentId: string): Promise<void> {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.state === "released") {
      return;
    }
    const statusResult = await this.git(workspace.worktreePath, ["status", "--porcelain=v1"]);
    if (statusResult.stdout.trim()) {
      this.store.database
        .prepare("UPDATE workspaces SET state = 'quarantined' WHERE workspace_id = ?")
        .run(workspaceId);
      throw new Error("Workspace has uncommitted changes and was quarantined instead of deleted");
    }
    await this.git(workspace.repositoryRoot, ["worktree", "remove", workspace.worktreePath]);
    const releasedAt = new Date().toISOString();
    const release = this.store.database.transaction(() => {
      this.store.database
        .prepare("UPDATE workspaces SET state = 'released', released_at = ? WHERE workspace_id = ?")
        .run(releasedAt, workspaceId);
      this.store.database
        .prepare("UPDATE territory_leases SET released_at = ? WHERE workspace_id = ? AND released_at IS NULL")
        .run(releasedAt, workspaceId);
      this.store.database
        .prepare("UPDATE agents SET current_workspace_id = NULL WHERE current_workspace_id = ?")
        .run(workspaceId);
      this.store.recordEvent({
        type: "workspace.released",
        summary: "Clean isolated workspace released",
        agentId: actorAgentId,
        goalId: workspace.goalId,
        metadata: { workspaceId },
      });
    });
    release();
  }

  quarantineWorkspace(workspaceId: string, actorAgentId: string, reason: string): void {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.state === "released") {
      throw new Error("Released workspace cannot be quarantined");
    }
    if (workspace.state === "quarantined") {
      return;
    }
    const quarantinedAt = new Date().toISOString();
    const quarantine = this.store.database.transaction(() => {
      this.store.database
        .prepare("UPDATE workspaces SET state = 'quarantined' WHERE workspace_id = ?")
        .run(workspaceId);
      this.store.database
        .prepare("UPDATE territory_leases SET released_at = ? WHERE workspace_id = ? AND released_at IS NULL")
        .run(quarantinedAt, workspaceId);
      this.store.database
        .prepare("UPDATE agents SET current_workspace_id = NULL WHERE current_workspace_id = ?")
        .run(workspaceId);
      this.store.recordEvent({
        type: "workspace.quarantined",
        summary: `Workspace quarantined: ${sanitizeText(reason, 300)}`,
        severity: "warning",
        agentId: actorAgentId,
        goalId: workspace.goalId,
        metadata: { workspaceId },
      });
    });
    quarantine();
  }

  acquireLease(input: {
    goalId: string;
    agentId: string;
    workspaceId: string;
    path: string;
    mode: WorkspaceMode;
    ttlMs: number;
  }): string {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 30_000 || input.ttlMs > 3_600_000) {
      throw new Error("Territory lease TTL must be from 30 seconds through one hour");
    }
    const workspace = this.getWorkspace(input.workspaceId);
    if (
      workspace.goalId !== input.goalId ||
      workspace.agentId !== input.agentId ||
      workspace.state === "released"
    ) {
      throw new Error("Territory lease does not match an active goal workspace");
    }
    if (input.mode === "write" && workspace.mode !== "write") {
      throw new Error("Read-only workspace cannot receive a write lease");
    }
    const normalizedPath = normalizeTerritoryPath(input.path);
    const comparisonPath = comparisonTerritoryPath(normalizedPath);
    const now = new Date();
    const acquiredAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    const leaseId = `lease-${randomUUID()}`;

    this.store.database.exec("BEGIN IMMEDIATE");
    try {
      this.store.database
        .prepare("UPDATE territory_leases SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?")
        .run(acquiredAt, acquiredAt);
      const active = this.store.database
        .prepare(`
          SELECT l.lease_id AS leaseId, l.agent_id AS agentId, l.mode, l.comparison_path AS comparisonPath
          FROM territory_leases l
          JOIN workspaces w ON w.workspace_id = l.workspace_id
          WHERE l.released_at IS NULL AND l.expires_at > ? AND w.repository_root = ?
        `)
        .all(acquiredAt, workspace.repositoryRoot) as Array<{
        leaseId: string;
        agentId: string;
        mode: WorkspaceMode;
        comparisonPath: string;
      }>;
      const conflict = active.find(
        (lease) =>
          pathsOverlap(comparisonPath, lease.comparisonPath) &&
          (input.mode === "write" || lease.mode === "write") &&
          lease.agentId !== input.agentId,
      );
      if (conflict) {
        throw new Error(`Territory conflicts with active lease ${conflict.leaseId}`);
      }
      this.store.database
        .prepare(`
          INSERT INTO territory_leases (
            lease_id, goal_id, agent_id, workspace_id, normalized_path, comparison_path,
            mode, acquired_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          leaseId,
          input.goalId,
          input.agentId,
          input.workspaceId,
          normalizedPath,
          comparisonPath,
          input.mode,
          acquiredAt,
          expiresAt,
        );
      this.store.recordEvent({
        type: "territory.acquired",
        summary: `${input.mode} lease acquired for ${normalizedPath}`,
        agentId: input.agentId,
        goalId: input.goalId,
        metadata: { leaseId, workspaceId: input.workspaceId, expiresAt },
      });
      this.store.database.exec("COMMIT");
    } catch (error) {
      this.store.database.exec("ROLLBACK");
      throw error;
    }
    return leaseId;
  }

  releaseLease(leaseId: string, agentId: string): void {
    const releasedAt = new Date().toISOString();
    const result = this.store.database
      .prepare(
        "UPDATE territory_leases SET released_at = ? WHERE lease_id = ? AND agent_id = ? AND released_at IS NULL",
      )
      .run(releasedAt, leaseId, agentId);
    if (result.changes !== 1) {
      throw new Error("Active territory lease was not found for this agent");
    }
    this.store.recordEvent({
      type: "territory.released",
      summary: "Territory lease released",
      agentId,
      metadata: { leaseId },
    });
  }

  async listFiles(
    agentId: string,
    workspaceId: string,
    directory = ".",
  ): Promise<Array<{ path: string; type: "file" | "directory"; size: number }>> {
    const workspace = this.getWorkspace(workspaceId);
    this.assertAgentWorkspace(workspace, agentId);
    const target = await this.resolveWithinWorkspace(workspace, directory, true);
    const entries = await readdir(target, { withFileTypes: true });
    return Promise.all(
      entries.slice(0, 500).map(async (entry) => {
        const entryPath = join(target, entry.name);
        const entryStats = await lstat(entryPath);
        const relativePath = relative(workspace.worktreePath, entryPath).split(sep).join("/");
        return {
          path: relativePath,
          type: entry.isDirectory() && !entry.isSymbolicLink() ? "directory" : "file",
          size: entryStats.size,
        } as const;
      }),
    );
  }

  async readWorkspaceFile(agentId: string, workspaceId: string, path: string): Promise<string> {
    const workspace = this.getWorkspace(workspaceId);
    this.assertAgentWorkspace(workspace, agentId);
    this.assertLease(agentId, workspace, path, "read");
    const target = await this.resolveWithinWorkspace(workspace, path, true);
    const fileStats = await stat(target);
    if (!fileStats.isFile() || fileStats.size > MAX_READ_BYTES) {
      throw new Error("Workspace read requires a regular file no larger than 1 MiB");
    }
    return readFile(target, "utf-8");
  }

  async readImmutableCandidateFile(workspaceId: string, path: string): Promise<string> {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.state === "released" || workspace.state === "quarantined") {
      throw new Error("Candidate workspace is not active");
    }
    const target = await this.resolveWithinWorkspace(workspace, path, true);
    const fileStats = await stat(target);
    if (!fileStats.isFile() || fileStats.size > MAX_READ_BYTES) {
      throw new Error("Candidate read requires a regular file no larger than 1 MiB");
    }
    return readFile(target, "utf-8");
  }

  async writeWorkspaceFile(
    agentId: string,
    workspaceId: string,
    path: string,
    content: string,
  ): Promise<void> {
    const workspace = this.getWorkspace(workspaceId);
    this.assertAgentWorkspace(workspace, agentId);
    if (workspace.mode !== "write") {
      throw new Error("Workspace is read-only");
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_BYTES) {
      throw new Error("Workspace write exceeds 1 MiB");
    }
    this.assertLease(agentId, workspace, path, "write");
    const target = await this.resolveWithinWorkspace(workspace, path, false);
    const parent = await this.resolveWithinWorkspace(workspace, dirname(path), true);
    this.store.invalidateArtifact(
      workspace.goalId,
      agentId,
      `Workspace write: ${normalizeTerritoryPath(path)}`,
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporaryPath = `${target}.oacc-${randomUUID()}.tmp`;
    await writeFile(temporaryPath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, target);
    this.store.database
      .prepare("UPDATE workspaces SET state = 'dirty' WHERE workspace_id = ?")
      .run(workspaceId);
    this.store.recordEvent({
      type: "workspace.file_written",
      summary: `Wrote ${normalizeTerritoryPath(path)}`,
      agentId,
      goalId: workspace.goalId,
      metadata: { workspaceId, bytes: Buffer.byteLength(content, "utf-8") },
    });
  }

  async replaceExactText(
    agentId: string,
    workspaceId: string,
    path: string,
    before: string,
    after: string,
  ): Promise<void> {
    if (!before) {
      throw new Error("Exact replacement requires non-empty existing text");
    }
    const current = await this.readWorkspaceFile(agentId, workspaceId, path);
    const firstIndex = current.indexOf(before);
    if (firstIndex < 0 || current.indexOf(before, firstIndex + before.length) >= 0) {
      throw new Error("Exact replacement text must occur once");
    }
    await this.writeWorkspaceFile(
      agentId,
      workspaceId,
      path,
      `${current.slice(0, firstIndex)}${after}${current.slice(firstIndex + before.length)}`,
    );
  }

  async searchWorkspace(
    agentId: string,
    workspaceId: string,
    query: string,
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    const workspace = this.getWorkspace(workspaceId);
    this.assertAgentWorkspace(workspace, agentId);
    if (!query || query.length > 200) {
      throw new Error("Search query must contain 1 through 200 characters");
    }
    const results: Array<{ path: string; line: number; text: string }> = [];
    let filesVisited = 0;
    const visit = async (directory: string): Promise<void> => {
      if (filesVisited >= MAX_SEARCH_FILES || results.length >= 200) {
        return;
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.isSymbolicLink()) {
          continue;
        }
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        filesVisited += 1;
        const fileStats = await stat(absolutePath);
        if (fileStats.size > MAX_READ_BYTES) {
          continue;
        }
        let content: string;
        try {
          content = await readFile(absolutePath, "utf-8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let index = 0; index < lines.length && results.length < 200; index += 1) {
          const line = lines[index];
          if (line?.includes(query)) {
            results.push({
              path: relative(workspace.worktreePath, absolutePath).split(sep).join("/"),
              line: index + 1,
              text: sanitizeText(line, 300),
            });
          }
        }
      }
    };
    await visit(workspace.worktreePath);
    return results;
  }

  async inspectWorkspace(workspaceId: string, agentId: string): Promise<WorkspaceInspection> {
    const workspace = this.getWorkspace(workspaceId);
    if (workspace.agentId !== agentId || workspace.state === "released") {
      throw new Error("Agent does not own an inspectable workspace");
    }
    const [status, unstaged, staged, revision] = await Promise.all([
      this.git(workspace.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.git(workspace.worktreePath, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--stat=80,30,10",
        "--",
        ".",
      ]),
      this.git(workspace.worktreePath, [
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--stat=80,30,10",
        "--",
        ".",
      ]),
      this.git(workspace.worktreePath, ["rev-parse", "HEAD"]),
    ]);
    const records = status.stdout.split("\u0000");
    const changes: WorkspaceInspection["changes"] = [];
    let changeCount = 0;
    const safePath = (value: string): string => {
      let sanitized = "";
      let unchangedFrom = 0;
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127) {
          sanitized += `${value.slice(unchangedFrom, index)}�`;
          unchangedFrom = index + 1;
        }
      }
      return sanitizeText(unchangedFrom === 0 ? value : `${sanitized}${value.slice(unchangedFrom)}`, 500);
    };
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      const indexStatus = record[0] ?? " ";
      const workingTreeStatus = record[1] ?? " ";
      const renamedOrCopied = /[RC]/.test(indexStatus) || /[RC]/.test(workingTreeStatus);
      const previousPath = renamedOrCopied ? records[index + 1] : null;
      if (previousPath) index += 1;
      changeCount += 1;
      if (changes.length < 200) {
        changes.push({
          path: safePath(record.slice(3)),
          previousPath: previousPath ? safePath(previousPath) : null,
          indexStatus,
          workingTreeStatus,
        });
      }
    }
    const summaries = [
      unstaged.stdout.trim() ? `Working tree:\n${unstaged.stdout.trim()}` : "",
      staged.stdout.trim() ? `Staged:\n${staged.stdout.trim()}` : "",
    ].filter(Boolean);
    return {
      workspaceId,
      currentRevision: revision.stdout.trim(),
      changes,
      changesTruncated: changeCount > changes.length,
      diffSummary: sanitizeText(
        summaries.join("\n\n") ||
          (changes.length > 0 ? "No tracked diff; untracked changes are listed." : "Clean worktree."),
        4_000,
      ),
      inspectedAt: new Date().toISOString(),
    };
  }

  getWorkspace(workspaceId: string): WorkspaceSummary {
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return workspace;
  }

  private async resolveRepositoryRoot(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error("Repository path must be absolute");
    }
    const candidate = await realpath(path);
    const root = (await this.git(candidate, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const canonicalRoot = await realpath(root);
    if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error("Repository path resolved outside its reported Git root");
    }
    return canonicalRoot;
  }

  private async git(cwd: string, arguments_: string[]): Promise<GitResult> {
    const result = await executeFile(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        ...arguments_,
      ],
      {
        cwd,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 4 * 1_048_576,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "false",
        },
      },
    );
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private assertAgentWorkspace(workspace: WorkspaceSummary, agentId: string): void {
    if (
      workspace.agentId !== agentId ||
      workspace.state === "released" ||
      workspace.state === "quarantined"
    ) {
      throw new Error("Agent does not own an active workspace");
    }
  }

  private assertLease(agentId: string, workspace: WorkspaceSummary, path: string, mode: WorkspaceMode): void {
    const comparisonPath = comparisonTerritoryPath(normalizeTerritoryPath(path));
    const now = new Date().toISOString();
    const leases = this.store.database
      .prepare(`
        SELECT comparison_path AS comparisonPath, mode FROM territory_leases
        WHERE workspace_id = ? AND agent_id = ? AND released_at IS NULL AND expires_at > ?
      `)
      .all(workspace.workspaceId, agentId, now) as Array<{ comparisonPath: string; mode: WorkspaceMode }>;
    const allowed = leases.some(
      (lease) =>
        pathCoveredByLease(comparisonPath, lease.comparisonPath) &&
        (mode === "read" || lease.mode === "write"),
    );
    if (!allowed) {
      throw new Error(`No active ${mode} territory lease covers ${path}`);
    }
  }

  private async resolveWithinWorkspace(
    workspace: WorkspaceSummary,
    path: string,
    mustExist: boolean,
  ): Promise<string> {
    const normalizedPath = normalizeTerritoryPath(path);
    const target = resolve(workspace.worktreePath, normalizedPath);
    const rootPrefix = `${workspace.worktreePath}${sep}`;
    if (target !== workspace.worktreePath && !target.startsWith(rootPrefix)) {
      throw new Error("Workspace path escaped the worktree");
    }
    if (mustExist) {
      const canonical = await realpath(target);
      if (canonical !== workspace.worktreePath && !canonical.startsWith(rootPrefix)) {
        throw new Error("Workspace path traversed a symlink outside the worktree");
      }
      return canonical;
    }
    const parent = await realpath(dirname(target));
    if (parent !== workspace.worktreePath && !parent.startsWith(rootPrefix)) {
      throw new Error("Workspace write parent escaped the worktree");
    }
    return target;
  }
}

export function normalizeTerritoryPath(path: string): string {
  const slashPath = path.trim().replaceAll("\\", "/");
  if (!slashPath || slashPath.includes("\u0000") || posix.isAbsolute(slashPath)) {
    throw new Error("Territory path must be a non-empty relative path");
  }
  const normalizedPath = posix.normalize(slashPath).replace(/^\.\//, "");
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error("Territory path cannot traverse above the workspace");
  }
  return normalizedPath === "." ? "" : normalizedPath;
}

export function comparisonTerritoryPath(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left === "" ||
    right === "" ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function pathCoveredByLease(path: string, leasePath: string): boolean {
  return leasePath === "" || path === leasePath || path.startsWith(`${leasePath}/`);
}
