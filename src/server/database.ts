import type { Database as DatabaseType } from "better-sqlite3";
import Database from "better-sqlite3";
import { AGENT_TEMPLATES, type AgentTemplate, ROLE_CONTRACT_VERSION, ROLE_CONTRACTS } from "./roles.js";

const SCHEMA_VERSION = 3;

export type SqliteDatabase = DatabaseType;

export function openDatabase(
  path: string,
  agentTemplates: readonly AgentTemplate[] = AGENT_TEMPLATES,
): SqliteDatabase {
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = FULL");
  database.pragma("trusted_schema = OFF");

  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS roles (
      role_id TEXT PRIMARY KEY,
      contract_version TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'orchestrator', 'director', 'specialist', 'verifier')),
      reports_to_role_id TEXT REFERENCES roles(role_id),
      contract_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(role_id),
      parent_agent_id TEXT REFERENCES agents(agent_id),
      state TEXT NOT NULL CHECK (state IN ('idle', 'queued', 'running', 'waiting_input', 'waiting_approval', 'verifying', 'blocked', 'failed', 'complete', 'disconnected', 'paused', 'cancelled')),
      current_goal_id TEXT,
      current_session_id TEXT,
      current_workspace_id TEXT,
      last_heartbeat_at TEXT,
      status_reason TEXT,
      temporary INTEGER NOT NULL DEFAULT 0 CHECK (temporary IN (0, 1)),
      created_at TEXT NOT NULL,
      archived_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS goals (
      goal_id TEXT PRIMARY KEY,
      parent_goal_id TEXT REFERENCES goals(goal_id),
      owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      required_checks_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('draft', 'queued', 'running', 'waiting_input', 'waiting_approval', 'verifying', 'blocked', 'failed', 'cancelled', 'rolled_back', 'complete')),
      risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
      data_class TEXT NOT NULL CHECK (data_class IN ('public', 'internal', 'confidential', 'privileged')),
      write_scope TEXT NOT NULL CHECK (write_scope IN ('none', 'isolated_repository')),
      external_effects_json TEXT NOT NULL,
      authorized_by TEXT REFERENCES agents(agent_id),
      artifact_identity TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      goal_id TEXT REFERENCES goals(goal_id),
      omp_session_id TEXT,
      process_id INTEGER,
      state TEXT NOT NULL CHECK (state IN ('configured', 'starting', 'ready', 'streaming', 'idle', 'stopping', 'exited', 'crashed', 'disconnected')),
      requested_provider TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      effective_provider TEXT,
      effective_model TEXT,
      reasoning TEXT NOT NULL,
      route_id TEXT NOT NULL,
      model_policy_version TEXT NOT NULL,
      model_decision_json TEXT NOT NULL,
      workspace_id TEXT,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      error_code TEXT,
      error_summary TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(agent_id),
      goal_id TEXT REFERENCES goals(goal_id),
      session_id TEXT REFERENCES sessions(session_id),
      type TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      recipient_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      goal_id TEXT REFERENCES goals(goal_id),
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      direction TEXT NOT NULL CHECK (direction IN ('owner_to_agent', 'agent_to_agent', 'agent_to_owner')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      repository_root TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      base_revision TEXT NOT NULL,
      current_revision TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
      state TEXT NOT NULL CHECK (state IN ('ready', 'dirty', 'released', 'quarantined')),
      integration_owner_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      created_at TEXT NOT NULL,
      released_at TEXT
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_workspace_per_agent
      ON workspaces(agent_id)
      WHERE state IN ('ready', 'dirty');

    CREATE TABLE IF NOT EXISTS territory_leases (
      lease_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
      normalized_path TEXT NOT NULL,
      comparison_path TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS territory_active_index
      ON territory_leases(workspace_id, comparison_path, mode)
      WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id),
      requested_by_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL UNIQUE,
      risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      decided_by TEXT REFERENCES agents(agent_id),
      decision_note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id),
      producer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      verifier_agent_id TEXT REFERENCES agents(agent_id),
      evidence_type TEXT NOT NULL,
      candidate_identity TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'unverified')),
      summary TEXT NOT NULL,
      limitations_json TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS check_definitions (
      check_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
      label TEXT NOT NULL,
      executable TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      relative_cwd TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 900000),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS check_runs (
      check_run_id TEXT PRIMARY KEY,
      check_id TEXT NOT NULL REFERENCES check_definitions(check_id),
      goal_id TEXT NOT NULL REFERENCES goals(goal_id),
      agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      candidate_identity TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'timeout', 'error')),
      exit_code INTEGER,
      output_summary TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS release_checks (
      release_check_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(goal_id),
      gate TEXT NOT NULL CHECK (gate IN ('quality', 'security', 'owner_approval', 'artifact_identity')),
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'missing', 'invalidated')),
      evidence_id TEXT REFERENCES evidence(evidence_id),
      artifact_hash TEXT NOT NULL,
      recorded_by_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS improvement_reviews (
      review_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      baseline TEXT NOT NULL,
      proposed_change TEXT NOT NULL,
      safety_metric TEXT NOT NULL,
      evaluation_plan TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'proposed', 'sandboxed', 'evaluated', 'canary', 'observing',
        'adopted', 'rejected', 'rolled_back'
      )),
      result_summary TEXT,
      limitations_json TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      artifact_identity TEXT NOT NULL,
      authorized_by TEXT NOT NULL REFERENCES agents(agent_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS api_sessions (
      session_hash TEXT PRIMARY KEY,
      csrf_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS api_sessions_by_expiry
      ON api_sessions(expires_at);

    CREATE UNIQUE INDEX IF NOT EXISTS one_live_session_per_agent
      ON sessions(agent_id)
      WHERE state IN ('configured', 'starting', 'ready', 'streaming', 'idle', 'stopping');

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_goal_per_agent
      ON goals(owner_agent_id)
      WHERE state IN ('queued', 'running', 'waiting_input', 'waiting_approval', 'verifying');
  `);

  const now = new Date().toISOString();
  const seedRoles = database.transaction(() => {
    const statement = database.prepare(`
      INSERT INTO roles (role_id, contract_version, display_name, kind, reports_to_role_id, contract_json, updated_at)
      VALUES (@roleId, @contractVersion, @displayName, @kind, @reportsToRoleId, @contractJson, @updatedAt)
      ON CONFLICT(role_id) DO UPDATE SET
        contract_version = excluded.contract_version,
        display_name = excluded.display_name,
        kind = excluded.kind,
        reports_to_role_id = excluded.reports_to_role_id,
        contract_json = excluded.contract_json,
        updated_at = excluded.updated_at
    `);
    for (const contract of Object.values(ROLE_CONTRACTS)) {
      statement.run({
        roleId: contract.roleId,
        contractVersion: ROLE_CONTRACT_VERSION,
        displayName: contract.displayName,
        kind: contract.kind,
        reportsToRoleId: contract.reportsToRoleId,
        contractJson: JSON.stringify(contract),
        updatedAt: now,
      });
    }
  });
  seedRoles();

  const seedAgents = database.transaction(() => {
    const statement = database.prepare(`
      INSERT INTO agents (
        agent_id, display_name, role_id, parent_agent_id, state, temporary, created_at
      ) VALUES (
        @agentId, @displayName, @roleId, @parentAgentId, 'idle', @temporary, @createdAt
      ) ON CONFLICT(agent_id) DO UPDATE SET
        display_name = excluded.display_name,
        role_id = excluded.role_id,
        parent_agent_id = excluded.parent_agent_id
      WHERE agents.archived_at IS NULL
    `);
    for (const agent of agentTemplates) {
      statement.run({
        agentId: agent.agentId,
        displayName: agent.displayName,
        roleId: agent.roleId,
        parentAgentId: agent.parentAgentId,
        temporary: agent.temporary ? 1 : 0,
        createdAt: now,
      });
    }
  });
  seedAgents();

  database
    .prepare(
      "INSERT INTO metadata (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(String(SCHEMA_VERSION));
  database
    .prepare(
      "INSERT INTO metadata (key, value) VALUES ('role_contract_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(ROLE_CONTRACT_VERSION);

  return database;
}
