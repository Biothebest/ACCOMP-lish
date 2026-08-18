import { resolve } from "node:path";
import { validateAgentCommandContracts } from "../src/server/agent-commands.js";
import { AGENT_TEMPLATES } from "../src/server/roles.js";

const commandDirectory = resolve(process.argv[2] ?? "agents");
const contracts = await validateAgentCommandContracts(commandDirectory, AGENT_TEMPLATES);
const identities = new Set(contracts.map((contract) => contract.identity));
if (identities.size !== contracts.length) {
  throw new Error("Every registered agent must have a distinct tailored command contract");
}
process.stdout.write(
  `Validated ${contracts.length} tailored agent command contracts in ${commandDirectory}\n`,
);
