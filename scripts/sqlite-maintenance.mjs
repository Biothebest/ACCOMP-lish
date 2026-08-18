import { chmod, copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(process.env.OACC_DATA_DIR || join(projectRoot, ".data"));
const databasePath = resolve(process.env.OACC_DATABASE_PATH || join(dataDir, "control-center.sqlite3"));
const [command = "verify", inputPath, confirmation] = process.argv.slice(2);

function timestamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "-");
}

function verifyDatabase(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error(`SQLite integrity_check failed for ${path}: ${JSON.stringify(integrity)}`);
    }
    const foreignKeys = database.pragma("foreign_key_check");
    if (foreignKeys.length > 0) {
      throw new Error(`SQLite foreign_key_check failed for ${path}: ${JSON.stringify(foreignKeys)}`);
    }
    const schema = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
    if (!schema?.value) {
      throw new Error(`SQLite metadata.schema_version is missing from ${path}`);
    }
    return String(schema.value);
  } finally {
    database.close();
  }
}

async function assertRegularFile(path) {
  const file = await stat(path);
  if (!file.isFile()) {
    throw new Error(`Expected a regular SQLite file: ${path}`);
  }
}

async function assertControllerStopped() {
  const lockPath = join(dataDir, "controller.lock");
  let record;
  try {
    record = JSON.parse(await readFile(lockPath, "utf-8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(`Controller lock is unreadable; refuse restore until inspected: ${lockPath}`);
  }
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) {
    throw new Error(`Controller lock is malformed; refuse restore until inspected: ${lockPath}`);
  }
  let live = true;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") live = false;
  }
  if (live) {
    throw new Error(`Controller process ${record.pid} is still using this data directory`);
  }
  await rename(lockPath, `${lockPath}.stale-${timestamp()}`);
}

async function backup() {
  await assertRegularFile(databasePath);
  const backupDirectory = join(dataDir, "backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const destination = join(backupDirectory, `control-center-${timestamp()}.sqlite3`);
  const temporary = `${destination}.partial`;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(temporary);
  } finally {
    database.close();
  }
  const schemaVersion = verifyDatabase(temporary);
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  process.stdout.write(`Verified SQLite backup created: ${destination} (schema ${schemaVersion})\n`);
}

async function restore() {
  if (!inputPath || confirmation !== "--confirm-controller-stopped") {
    throw new Error("Restore requires: restore <verified-backup.sqlite3> --confirm-controller-stopped");
  }
  await assertControllerStopped();
  const source = resolve(inputPath);
  if (source === databasePath) {
    throw new Error("Restore source must differ from the live database path");
  }
  await assertRegularFile(source);
  const sourceSchema = verifyDatabase(source);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });

  try {
    const live = new Database(databasePath, { fileMustExist: true, timeout: 1_000 });
    try {
      live.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } finally {
      live.close();
    }
  } catch (error) {
    throw new Error(`Could not exclusively lock the target; stop the controller before restore: ${error}`);
  }

  const suffix = timestamp();
  const staged = `${databasePath}.restore-${suffix}.partial`;
  await copyFile(source, staged);
  verifyDatabase(staged);
  await chmod(staged, 0o600);

  const rollback = `${databasePath}.pre-restore-${suffix}`;
  try {
    await rename(databasePath, rollback);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const companion of ["-wal", "-shm"]) {
    try {
      await rename(`${databasePath}${companion}`, `${rollback}${companion}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await rename(staged, databasePath);
  const restoredSchema = verifyDatabase(databasePath);
  if (restoredSchema !== sourceSchema) {
    throw new Error(`Restored schema mismatch: expected ${sourceSchema}, received ${restoredSchema}`);
  }
  process.stdout.write(
    `Verified SQLite restore completed: ${databasePath} (schema ${restoredSchema}); prior database: ${rollback}\n`,
  );
}

if (command === "backup") {
  await backup();
} else if (command === "restore") {
  await restore();
} else if (command === "verify") {
  const target = resolve(inputPath || databasePath);
  await assertRegularFile(target);
  const schemaVersion = verifyDatabase(target);
  process.stdout.write(`SQLite verification passed: ${target} (schema ${schemaVersion})\n`);
} else {
  throw new Error(`Unknown command: ${command}`);
}
