import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentSummary } from "../shared/contracts.js";
import type { AgentTemplate } from "./roles.js";

export const AGENT_COMMAND_CONTRACT_VERSION = 1;
export const MAX_AGENT_COMMAND_BYTES = 6_000;

const SAFE_AGENT_ID = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const REQUIRED_SECTIONS = [
  "## Identity and mission",
  "## Hierarchy and authority",
  "## Tailored commands",
  "## Operating sequence",
  "## OMP tool envelope",
  "## Required evidence",
  "## Escalate immediately when",
  "## Definition of done",
  "## Never",
] as const;

export interface AgentCommandContract {
  agentId: string;
  roleId: string;
  reportsToAgentId: string | null;
  version: number;
  identity: string;
  content: string;
}

type CommandAgent = Pick<AgentSummary, "agentId" | "roleId" | "parentAgentId"> | AgentTemplate;

export async function loadAgentCommandContract(
  commandDirectory: string,
  agent: CommandAgent,
): Promise<AgentCommandContract> {
  if (!SAFE_AGENT_ID.test(agent.agentId)) {
    throw new Error(`Agent command contract has an unsafe agent ID: ${agent.agentId}`);
  }
  const root = await realpath(resolve(commandDirectory));
  const candidate = resolve(root, `${agent.agentId}.md`);
  if (dirname(candidate) !== root) {
    throw new Error(`Agent command contract escapes its configured directory: ${agent.agentId}`);
  }
  const file = await lstat(candidate).catch(() => null);
  if (!file?.isFile() || file.isSymbolicLink()) {
    throw new Error(`Agent command contract must be a regular checked-in file: ${agent.agentId}.md`);
  }
  if (file.size < 1 || file.size > MAX_AGENT_COMMAND_BYTES) {
    throw new Error(
      `Agent command contract must contain 1-${MAX_AGENT_COMMAND_BYTES} bytes: ${agent.agentId}.md`,
    );
  }
  const resolvedCandidate = await realpath(candidate);
  if (dirname(resolvedCandidate) !== root) {
    throw new Error(`Agent command contract resolves outside its configured directory: ${agent.agentId}.md`);
  }
  const content = await readFile(resolvedCandidate, "utf-8");
  if (Buffer.byteLength(content, "utf-8") !== file.size) {
    throw new Error(`Agent command contract changed while it was being loaded: ${agent.agentId}.md`);
  }
  const metadata = parseMetadata(content, agent.agentId);
  const expectedParent = agent.parentAgentId ?? "none";
  if (metadata.agent_id !== agent.agentId) {
    throw new Error(`Agent command contract agent_id mismatch: ${agent.agentId}.md`);
  }
  if (metadata.role_id !== agent.roleId) {
    throw new Error(`Agent command contract role_id mismatch: ${agent.agentId}.md`);
  }
  if (metadata.reports_to !== expectedParent) {
    throw new Error(`Agent command contract reports_to mismatch: ${agent.agentId}.md`);
  }
  if (metadata.command_contract_version !== String(AGENT_COMMAND_CONTRACT_VERSION)) {
    throw new Error(`Unsupported agent command contract version: ${agent.agentId}.md`);
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      throw new Error(`Agent command contract is missing ${section}: ${agent.agentId}.md`);
    }
  }
  return {
    agentId: agent.agentId,
    roleId: agent.roleId,
    reportsToAgentId: agent.parentAgentId,
    version: AGENT_COMMAND_CONTRACT_VERSION,
    identity: createHash("sha256").update(content).digest("hex"),
    content,
  };
}

export async function validateAgentCommandContracts(
  commandDirectory: string,
  agents: readonly AgentTemplate[],
): Promise<readonly AgentCommandContract[]> {
  const duplicateAgentIds = agents
    .map((agent) => agent.agentId)
    .filter((agentId, index, values) => values.indexOf(agentId) !== index);
  if (duplicateAgentIds.length > 0) {
    throw new Error(`Duplicate registered agent IDs: ${[...new Set(duplicateAgentIds)].join(", ")}`);
  }
  const contracts = await Promise.all(
    agents.map((agent) => loadAgentCommandContract(commandDirectory, agent)),
  );
  const expectedFiles = new Set(agents.map((agent) => `${agent.agentId}.md`));
  const unexpectedFiles = (await readdir(commandDirectory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".md") && entry.name !== "README.md")
    .filter((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpectedFiles.length > 0) {
    throw new Error(`Unexpected agent command contract files: ${unexpectedFiles.join(", ")}`);
  }
  return contracts;
}

function parseMetadata(content: string, agentId: string): Record<string, string> {
  const match = /^<!--\r?\n([\s\S]*?)\r?\n-->/.exec(content);
  if (!match?.[1]) {
    throw new Error(`Agent command contract is missing its metadata comment: ${agentId}.md`);
  }
  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error(`Agent command contract has malformed metadata: ${agentId}.md`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (metadata[key] !== undefined || value.length === 0) {
      throw new Error(`Agent command contract has invalid ${key} metadata: ${agentId}.md`);
    }
    metadata[key] = value;
  }
  const expectedKeys = ["agent_id", "role_id", "reports_to", "command_contract_version"];
  const actualKeys = Object.keys(metadata).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys.sort())) {
    throw new Error(`Agent command contract metadata keys do not match the schema: ${agentId}.md`);
  }
  return metadata;
}
