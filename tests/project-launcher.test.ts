import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTaskUrl,
  initializeProject,
  installGlobalCommand,
  listProjects,
  projectStatus,
  startProject,
  stopProject,
} from "../scripts/accomplish-lib.mjs";
import { parseAccomplishGoalPrefill } from "../src/client/accomplish.js";

const temporaryRoots: string[] = [];
const runningProjects: Array<{ project: Awaited<ReturnType<typeof initializeProject>>; coreRoot: string }> =
  [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function gitRepository(prefix: string): Promise<string> {
  const repository = await temporaryDirectory(prefix);
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  await writeFile(join(repository, "project.txt"), `${prefix}\n`, "utf-8");
  return repository;
}

async function fakeServer(root: string): Promise<string> {
  const path = join(root, "fake-server.mjs");
  await writeFile(
    path,
    `import { createServer } from "node:http";
const port = Number(process.env.ACCOMPLISH_PORT);
const payload = JSON.stringify({
  status: "ok",
  productName: "ACCOMP-lish",
  version: "test",
  safetyMode: "local_only",
  projectId: process.env.ACCOMPLISH_PROJECT_ID,
  organizationName: "Test Project",
  processId: process.pid,
  instanceId: process.env.ACCOMPLISH_INSTANCE_ID,
  port,
});
const server = createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`,
    "utf-8",
  );
  return path;
}

afterEach(async () => {
  for (const item of runningProjects.splice(0)) {
    try {
      await stopProject(item.project, { stopTimeoutMs: 5_000 });
    } catch {
      // The assertion may have already stopped the isolated test process.
    }
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACCOMP-lish project capsules", () => {
  it("registers concurrent Git projects without writing controller state into either repository", async () => {
    const home = await temporaryDirectory("accomplish-home-");
    const firstRepository = await gitRepository("accomplish-first-");
    const secondRepository = await gitRepository("accomplish-second-");

    const [first, second] = await Promise.all([
      initializeProject({
        home,
        cwd: firstRepository,
        name: "First Project",
        ownerDisplayName: "Owner",
        ompProfile: "test",
      }),
      initializeProject({
        home,
        cwd: secondRepository,
        name: "Second Project",
        ownerDisplayName: "Owner",
        ompProfile: "test",
      }),
    ]);

    expect(first.projectId).not.toBe(second.projectId);
    expect(first.port).not.toBe(second.port);
    expect(first.capsuleDirectory.startsWith(home)).toBe(true);
    expect(second.capsuleDirectory.startsWith(home)).toBe(true);
    expect(await readdir(firstRepository)).toEqual([".git", "project.txt"]);
    expect(await readdir(secondRepository)).toEqual([".git", "project.txt"]);
    const registeredProjects = (await listProjects({ home })) as Array<{ projectId: string }>;
    expect(registeredProjects.map((project) => project.projectId).sort()).toEqual(
      [first.projectId, second.projectId].sort(),
    );

    const reinitialized = await initializeProject({
      home,
      cwd: firstRepository,
      name: "First Project",
      ownerDisplayName: "Owner",
      ompProfile: "test",
    });
    expect(reinitialized.port).toBe(first.port);
    expect(JSON.parse(await readFile(first.configPath, "utf-8"))).toMatchObject({
      organizationName: "First Project",
      ownerDisplayName: "Owner",
      ompProfile: "test",
    });
  });

  it("starts and stops only the controller process matching the recorded project identity", async () => {
    const home = await temporaryDirectory("accomplish-runtime-home-");
    const repository = await gitRepository("accomplish-runtime-project-");
    const coreRoot = await temporaryDirectory("accomplish-fake-core-");
    const serverEntry = await fakeServer(coreRoot);
    const project = await initializeProject({
      home,
      cwd: repository,
      name: "Runtime Project",
      ownerDisplayName: "Owner",
      ompProfile: "test",
    });
    runningProjects.push({ project, coreRoot });

    const lifecycleOptions = { coreRoot, serverEntry, startTimeoutMs: 5_000, stopTimeoutMs: 5_000 };
    const [started, duplicateStart] = await Promise.all([
      startProject(project, lifecycleOptions),
      startProject(project, lifecycleOptions),
    ]);
    expect(started.state).toBe("running");
    expect(started.health?.projectId).toBe(project.projectId);
    expect(duplicateStart.runtime.processId).toBe(started.runtime.processId);
    expect((await projectStatus(project)).state).toBe("running");

    const foreignProject = {
      ...project,
      projectId: "0000000000000000",
      runtimePath: join(project.capsuleDirectory, "foreign-runtime.json"),
    };
    expect((await projectStatus(foreignProject)).state).toBe("port_conflict");
    await expect(stopProject(foreignProject)).rejects.toThrow("Refusing to stop");
    expect((await projectStatus(project)).state).toBe("running");

    await Promise.all([stopProject(project, lifecycleOptions), stopProject(project, lifecycleOptions)]);
    runningProjects.splice(0);
    expect((await projectStatus(project)).state).toBe("stopped");
  });

  it("encodes a task as a reviewed dashboard prefill instead of dispatching it", async () => {
    const home = await temporaryDirectory("accomplish-task-home-");
    const repository = await gitRepository("accomplish-task-project-");
    const project = await initializeProject({
      home,
      cwd: repository,
      name: "Task Project",
      ownerDisplayName: "Owner",
      ompProfile: "test",
    });
    const url = buildTaskUrl(project, {
      task: "Improve scheduling",
      description: "Preserve tenant isolation & owner review.",
      outcome: "A verified draft is ready for explicit dispatch.",
    });
    const parsedUrl = new URL(url);

    expect(parsedUrl.search).toBe("");
    expect(parseAccomplishGoalPrefill(parsedUrl.hash)).toEqual({
      task: "Improve scheduling",
      description: "Preserve tenant isolation & owner review.",
      outcome: "A verified draft is ready for explicit dispatch.",
    });
    expect(parseAccomplishGoalPrefill("#accomplish=1&task=incomplete")).toBeNull();
  });

  it("installs an idempotent symlink and refuses to overwrite an unrelated command", async () => {
    const root = await temporaryDirectory("accomplish-install-");
    const sourcePath = join(root, "accomplish.mjs");
    const binDirectory = join(root, "bin");
    await writeFile(sourcePath, "#!/usr/bin/env node\n", { mode: 0o700 });

    const installed = await installGlobalCommand({ sourcePath, binDirectory });
    expect(installed.installed).toBe(true);
    expect((await installGlobalCommand({ sourcePath, binDirectory })).installed).toBe(false);

    const occupiedBin = join(root, "occupied-bin");
    await mkdir(occupiedBin);
    await writeFile(join(occupiedBin, "accomplish"), "unrelated\n", "utf-8");
    await expect(installGlobalCommand({ sourcePath, binDirectory: occupiedBin })).rejects.toThrow(
      "Refusing to replace non-symlink command",
    );
  });
});
