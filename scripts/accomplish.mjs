#!/usr/bin/env node

import {
  initializeProject,
  installGlobalCommand,
  listProjects,
  openUrl,
  PRODUCT_NAME,
  prepareTask,
  projectStatus,
  resolveProject,
  startProject,
  stopProject,
} from "./accomplish-lib.mjs";

const VALUE_OPTIONS = new Set([
  "--description",
  "--name",
  "--omp-profile",
  "--outcome",
  "--owner",
  "--port",
  "--project",
  "--repository",
  "--task",
]);
const BOOLEAN_OPTIONS = new Set(["--help", "--json", "--no-open"]);
const COMMANDS = new Set(["help", "init", "install", "open", "projects", "status", "stop", "task", "up"]);

function usage() {
  return `${PRODUCT_NAME} — project-isolated OMP operations\n\nUsage:\n  accomplish init [--name NAME] [--owner NAME] [--omp-profile PROFILE]\n  accomplish up [--project PROJECT_ID]\n  accomplish open [--project PROJECT_ID]\n  accomplish task TASK --description TEXT --outcome TEXT [--project PROJECT_ID]\n  accomplish status [--project PROJECT_ID] [--json]\n  accomplish stop [--project PROJECT_ID]\n  accomplish projects [--json]\n  accomplish install\n\nRun init once from each Git repository. Task opens a reviewed, prefilled goal; it never dispatches work automatically.`;
}

export function parseCommandLine(argv) {
  const tokens = [...argv];
  let command = tokens.shift() ?? "help";
  if (command === "--help" || command === "-h") {
    return { command: "help", options: {}, positionals: [] };
  }
  const inferredTask = !COMMANDS.has(command);
  const positionals = inferredTask ? [command] : [];
  if (inferredTask) command = "task";
  const options = {};
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (BOOLEAN_OPTIONS.has(token)) {
      options[token.slice(2)] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = tokens.shift();
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      options[token.slice(2)] = value;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    positionals.push(token);
  }
  return { command, options, positionals };
}

function integerOption(value, name) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  return Number(value);
}

async function selectedProject(options) {
  return resolveProject({
    projectId: options.project,
    cwd: options.repository,
  });
}

function statusSummary(status) {
  const project = status.project;
  return {
    projectId: project.projectId,
    name: project.name,
    repositoryRoot: project.repositoryRoot,
    port: project.port,
    url: project.url,
    state: status.state,
    processId: status.runtime?.processId ?? null,
  };
}

function printProject(project) {
  console.log(`${project.name} (${project.projectId})`);
  console.log(`  Repository: ${project.repositoryRoot}`);
  console.log(`  Dashboard:  ${project.url}`);
  console.log(`  Capsule:    ${project.capsuleDirectory}`);
}

async function run(argv) {
  const { command, options, positionals } = parseCommandLine(argv);
  if (options.help || command === "help") {
    console.log(usage());
    return;
  }

  if (command === "install") {
    const result = await installGlobalCommand();
    console.log(
      result.installed
        ? `Installed ${result.targetPath} -> ${result.sourcePath}`
        : `Already installed: ${result.targetPath}`,
    );
    return;
  }

  if (command === "init") {
    if (positionals.length > 0) throw new Error("init accepts options only");
    const project = await initializeProject({
      cwd: options.repository,
      name: options.name,
      ownerDisplayName: options.owner,
      ompProfile: options["omp-profile"],
      port: integerOption(options.port, "--port"),
    });
    console.log("Initialized isolated ACCOMP-lish project capsule:");
    printProject(project);
    return;
  }

  if (command === "projects") {
    if (positionals.length > 0) throw new Error("projects accepts options only");
    const projects = await listProjects();
    const statuses = await Promise.all(projects.map((project) => projectStatus(project)));
    const summaries = statuses.map(statusSummary);
    if (options.json) console.log(JSON.stringify(summaries, null, 2));
    else if (summaries.length === 0) console.log("No ACCOMP-lish projects are initialized.");
    else {
      for (const summary of summaries) {
        console.log(`${summary.state.padEnd(18)} ${summary.name} (${summary.projectId}) ${summary.url}`);
      }
    }
    return;
  }

  const project = await selectedProject(options);
  if (command === "status") {
    if (positionals.length > 0) throw new Error("status accepts options only");
    const summary = statusSummary(await projectStatus(project));
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      printProject(project);
      console.log(`  State:      ${summary.state}`);
      if (summary.processId) console.log(`  Process:    ${summary.processId}`);
    }
    return;
  }

  if (command === "up" || command === "open") {
    if (positionals.length > 0) throw new Error(`${command} accepts options only`);
    await startProject(project);
    if (command === "open") await openUrl(project.url, { noOpen: options["no-open"] });
    console.log(`${project.name} is running at ${project.url}`);
    return;
  }

  if (command === "stop") {
    if (positionals.length > 0) throw new Error("stop accepts options only");
    await stopProject(project);
    console.log(`${project.name} is stopped.`);
    return;
  }

  if (command === "task") {
    const task = options.task ?? positionals.join(" ").trim();
    if (!task) throw new Error("task requires a task title");
    if (!options.description) throw new Error("task requires --description");
    if (!options.outcome) throw new Error("task requires --outcome");
    const prepared = await prepareTask(
      project,
      { task, description: options.description, outcome: options.outcome },
      { noOpen: options["no-open"] },
    );
    console.log(`Prepared reviewed goal for ${project.name}:`);
    console.log(`  ${prepared.url}`);
    console.log("Review the goal in ACCOMP-lish, then explicitly select Dispatch goal.");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch((error) => {
  console.error(`accomplish: ${error instanceof Error ? error.message : "command failed"}`);
  process.exitCode = 1;
});
