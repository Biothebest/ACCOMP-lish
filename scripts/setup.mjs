#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    '  npm run setup -- --organization "Organization Name" --owner "Owner Name" --omp-profile "profile"',
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
    const match = /^(--organization|--owner|--omp-profile)(?:=(.*))?$/.exec(argument);
    if (!match) {
      throw new Error(`Unknown setup option: ${argument}`);
    }
    const value = match[2] ?? arguments_[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${match[1]} requires a value`);
    }
    if (match[1] === "--organization") result.organizationName = value;
    if (match[1] === "--owner") result.ownerDisplayName = value;
    if (match[1] === "--omp-profile") result.ompProfile = value;
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

function validateProfile(value) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error("OMP profile must contain 1–64 letters, digits, dots, underscores, or hyphens");
  }
  return normalized;
}

async function discoverProfiles() {
  const profiles = new Set(["default"]);
  try {
    const entries = await readdir(join(homedir(), ".omp", "profiles"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)) {
        profiles.add(entry.name);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [...profiles].sort();
}

async function readDefaults() {
  const existingConfiguration = existsSync(configPath);
  const source = existingConfiguration ? configPath : examplePath;
  const parsed = JSON.parse(await readFile(source, "utf-8"));
  const availableProfiles = await discoverProfiles();
  const configuredProfile = typeof parsed.ompProfile === "string" ? validateProfile(parsed.ompProfile) : null;
  const environmentProfile =
    typeof process.env.OMP_PROFILE === "string" ? validateProfile(process.env.OMP_PROFILE) : null;
  const preferredProfile = existingConfiguration
    ? (configuredProfile ?? environmentProfile ?? "default")
    : (environmentProfile ?? configuredProfile ?? "default");
  return {
    organizationName: validateLabel("Organization name", parsed.organizationName),
    ownerDisplayName: validateLabel("Owner name", parsed.ownerDisplayName),
    ompProfile: availableProfiles.includes(preferredProfile) ? preferredProfile : "default",
    availableProfiles,
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
let ompProfile = options.ompProfile;

if ((!organizationName || !ownerDisplayName || !ompProfile) && process.stdin.isTTY && process.stdout.isTTY) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`Available OMP profiles: ${defaults.availableProfiles.join(", ")}\n`);
  try {
    organizationName ||= await prompt.question(`Organization name (${defaults.organizationName}): `);
    ownerDisplayName ||= await prompt.question(`Owner display name (${defaults.ownerDisplayName}): `);
    ompProfile ||= await prompt.question(`OMP profile (${defaults.ompProfile}): `);
  } finally {
    prompt.close();
  }
  organizationName ||= defaults.organizationName;
  ownerDisplayName ||= defaults.ownerDisplayName;
  ompProfile ||= defaults.ompProfile;
}

if (!organizationName || !ownerDisplayName || !ompProfile) {
  throw new Error(`Non-interactive setup requires --organization, --owner, and --omp-profile\n\n${usage()}`);
}

ompProfile = validateProfile(ompProfile);
if (!defaults.availableProfiles.includes(ompProfile)) {
  throw new Error(
    `OMP profile "${ompProfile}" does not exist. Available profiles: ${defaults.availableProfiles.join(", ")}`,
  );
}

const configuration = {
  schemaVersion: 2,
  organizationName: validateLabel("Organization name", organizationName),
  ownerDisplayName: validateLabel("Owner name", ownerDisplayName),
  ompProfile,
};
await mkdir(configDirectory, { recursive: true });
await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
  encoding: "utf-8",
  mode: 0o600,
});
process.stdout.write(
  [
    `Created ${configPath}`,
    `OMP profile "${ompProfile}" selected.`,
    `Next: open the exact OMP session for this profile, run /collab, then scan or paste its full-control link in the dashboard.`,
    "",
  ].join("\n"),
);
