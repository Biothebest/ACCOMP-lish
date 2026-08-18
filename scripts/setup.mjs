#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDirectory = join(projectRoot, "config");
const configPath = join(configDirectory, "organization.json");
const examplePath = join(configDirectory, "organization.example.json");

function usage() {
  return [
    "Usage:",
    '  npm run setup -- --organization "Organization Name" --owner "Owner Name"',
    "",
    "With an interactive terminal, omitted values are prompted.",
  ].join("\n");
}

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const match = /^(--organization|--owner)(?:=(.*))?$/.exec(argument);
    if (!match) {
      throw new Error(`Unknown setup option: ${argument}`);
    }
    const value = match[2] ?? arguments_[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${match[1]} requires a value`);
    }
    if (match[1] === "--organization") result.organizationName = value;
    if (match[1] === "--owner") result.ownerDisplayName = value;
  }
  return result;
}

function validateLabel(label, value) {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127);
  });
  if (!normalized || normalized.length > 80 || hasControlCharacter) {
    throw new Error(`${label} must contain 1–80 printable characters`);
  }
  return normalized;
}

async function readDefaults() {
  const source = existsSync(configPath) ? configPath : examplePath;
  const parsed = JSON.parse(await readFile(source, "utf-8"));
  return {
    organizationName: validateLabel("Organization name", parsed.organizationName),
    ownerDisplayName: validateLabel("Owner name", parsed.ownerDisplayName),
  };
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const defaults = await readDefaults();
let organizationName = options.organizationName;
let ownerDisplayName = options.ownerDisplayName;

if ((!organizationName || !ownerDisplayName) && process.stdin.isTTY && process.stdout.isTTY) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    organizationName ||= await prompt.question(`Organization name (${defaults.organizationName}): `);
    ownerDisplayName ||= await prompt.question(`Owner display name (${defaults.ownerDisplayName}): `);
  } finally {
    prompt.close();
  }
  organizationName ||= defaults.organizationName;
  ownerDisplayName ||= defaults.ownerDisplayName;
}

if (!organizationName || !ownerDisplayName) {
  throw new Error(`Non-interactive setup requires --organization and --owner\n\n${usage()}`);
}

const configuration = {
  schemaVersion: 1,
  organizationName: validateLabel("Organization name", organizationName),
  ownerDisplayName: validateLabel("Owner name", ownerDisplayName),
};
await mkdir(configDirectory, { recursive: true });
await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
  encoding: "utf-8",
  mode: 0o600,
});
process.stdout.write(`Created ${configPath}\n`);
