# Agent command contracts

Every registered agent has exactly one checked-in Markdown command contract named `<agent-id>.md`. The controller loads and validates that file before starting the agent's OMP process. A missing, oversized, symlinked, or identity-mismatched file blocks the session.

The leading metadata comment is mandatory:

```text
<!--
agent_id: AGT-EXAMPLE
role_id: ROLE-EXAMPLE
reports_to: DIR-EXAMPLE
command_contract_version: 1
-->
```

Use `reports_to: none` only for the human owner. The values must match the registered hierarchy in `src/server/roles.ts`.

Each document defines:

- Identity, mission, and reporting line
- Authority boundaries
- Tailored intent commands
- Operating sequence
- Allowed OMP host-tool envelope
- Required evidence
- Escalation conditions
- Definition of done
- Prohibited behavior

These files improve role focus; they do not grant authority. Runtime role contracts, bound goals, workspace leases, host-tool validation, independent verification, and owner approval remain the enforcing controls.

After changing any command contract, run:

```bash
npm run validate:agents
npm test
```
