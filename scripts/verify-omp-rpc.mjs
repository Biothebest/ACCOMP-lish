import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const ompPath = resolve(process.env.OACC_OMP_PATH || join(homedir(), ".local", "bin", "omp"));
const directory = await mkdtemp(join(tmpdir(), "oacc-omp-proof-"));
const configPath = join(directory, "restricted.yml");
const config = [
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
await writeFile(configPath, config, { encoding: "utf-8", mode: 0o600 });
await chmod(configPath, 0o600);

const child = spawn(
  ompPath,
  [
    "--mode",
    "rpc",
    "--cwd",
    directory,
    "--config",
    configPath,
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-lsp",
    "--no-pty",
  ],
  {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: homedir(),
      TMPDIR: directory,
      PI_RPC_EMIT_TITLE: "0",
      NO_COLOR: "1",
    },
  },
);

const ready = Promise.withResolvers();
const exited = Promise.withResolvers();
const pending = new Map();
let nextId = 1;
let stderr = "";
let settledExit = false;

child.stderr.setEncoding("utf-8");
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4_000);
});
child.stdin.on("error", () => {
  // Exit handling below settles every pending request.
});
child.on("error", (error) => {
  ready.reject(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
});
child.on("exit", (code, signal) => {
  settledExit = true;
  const error =
    code === 0 ? null : new Error(stderr || `OMP exited with code ${String(code)} signal ${String(signal)}`);
  if (error) {
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
  }
  pending.clear();
  exited.resolve({ code, signal });
});

const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  if (Buffer.byteLength(line, "utf-8") > 1_048_576) {
    ready.reject(new Error("OMP emitted an oversized physical frame"));
    return;
  }
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    ready.reject(new Error("OMP emitted malformed JSON"));
    return;
  }
  if (!frame || Array.isArray(frame) || typeof frame !== "object" || typeof frame.type !== "string") {
    ready.reject(new Error("OMP emitted an invalid RPC frame"));
    return;
  }
  if (frame.type === "ready") {
    ready.resolve(frame);
    return;
  }
  if (frame.type === "response" && typeof frame.id === "string") {
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (frame.success === true) request.resolve(frame);
    else request.reject(new Error(typeof frame.error === "string" ? frame.error : "OMP request failed"));
  }
});

function withDeadline(promise, label, milliseconds = 15_000) {
  const deadline = Promise.withResolvers();
  const handle = setTimeout(() => deadline.reject(new Error(`${label} timed out`)), milliseconds);
  handle.unref();
  return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(handle));
}

function request(type, payload = {}) {
  if (settledExit || child.stdin.destroyed) return Promise.reject(new Error("OMP process is not writable"));
  const id = `proof-${nextId}`;
  nextId += 1;
  const result = Promise.withResolvers();
  pending.set(id, result);
  child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  return withDeadline(result.promise, type);
}

let outcome = "failed";
try {
  const readyFrame = await withDeadline(ready.promise, "ready frame");
  if (
    !Array.isArray(readyFrame.supportedProtocolVersions) ||
    !readyFrame.supportedProtocolVersions.includes(2) ||
    readyFrame.maxFrameBytes !== 1_048_576 ||
    typeof readyFrame.maxReassembledFrameBytes !== "number"
  ) {
    throw new Error("OMP ready frame does not satisfy the pinned RPC v2 framing contract");
  }

  await request("negotiate_protocol", { protocolVersion: 2 });
  await request("set_host_tools", { tools: [] });
  await request("set_subagent_subscription", { level: "off" });
  await request("set_steering_mode", { mode: "one-at-a-time" });
  await request("set_follow_up_mode", { mode: "one-at-a-time" });
  await request("set_interrupt_mode", { mode: "wait" });
  const stateResponse = await request("get_state");
  const state = stateResponse.data;
  if (!state || typeof state !== "object" || state.sessionFile != null) {
    throw new Error("OMP enabled session-file persistence or returned invalid state");
  }
  if (!Array.isArray(state.dumpTools) || state.dumpTools.length !== 0) {
    throw new Error("OMP exposed tools during the no-tools compatibility probe");
  }

  outcome = `passed: protocol v2, ${readyFrame.maxFrameBytes} byte frames, ${readyFrame.maxReassembledFrameBytes} byte reassembly, no tools, no session file`;
} finally {
  child.stdin.end();
  if (!settledExit) {
    try {
      await withDeadline(exited.promise, "OMP shutdown", 5_000);
    } catch {
      child.kill("SIGTERM");
      await withDeadline(exited.promise, "OMP termination", 5_000);
    }
  }
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write(`OMP RPC compatibility ${outcome}\n`);
