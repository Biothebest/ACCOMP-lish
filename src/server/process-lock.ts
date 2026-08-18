import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LockRecord {
  pid: number;
  token: string;
  startedAt: string;
}

export interface ControllerProcessLock {
  readonly path: string;
  release(): void;
}

export function controllerLockPath(dataDir: string): string {
  return join(dataDir, "controller.lock");
}

function readLock(path: string): LockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockRecord>;
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length < 16 ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as LockRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireControllerLock(dataDir: string): ControllerProcessLock {
  const path = controllerLockPath(dataDir);
  const token = randomUUID();
  const record: LockRecord = { pid: process.pid, token, startedAt: new Date().toISOString() };

  for (;;) {
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = readLock(path);
      if (existing && processIsLive(existing.pid)) {
        throw new Error(`Controller data directory is already owned by live process ${existing.pid}`);
      }
      try {
        const stalePath = `${path}.stale-${randomUUID()}`;
        renameSync(path, stalePath);
        unlinkSync(stalePath);
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw staleError;
        }
      }
      continue;
    }

    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: "utf-8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    let released = false;
    return {
      path,
      release(): void {
        if (released) {
          return;
        }
        const current = readLock(path);
        if (current?.token === token) {
          unlinkSync(path);
        }
        released = true;
      },
    };
  }
}
