import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config.js";
import { ControlCenter } from "../src/server/control-center.js";
import type { LiveEvent } from "../src/server/events.js";

function waitForEvent(
  center: ControlCenter,
  predicate: (event: LiveEvent) => boolean,
  label: string,
): Promise<LiveEvent> {
  const pending = Promise.withResolvers<LiveEvent>();
  const timeout = setTimeout(
    () => pending.reject(new Error(`Live OMP smoke timed out waiting for ${label}`)),
    60_000,
  );
  timeout.unref();
  let unsubscribe = (): void => undefined;
  unsubscribe = center.events.subscribe((event) => {
    if (predicate(event)) {
      clearTimeout(timeout);
      unsubscribe();
      pending.resolve(event);
    }
  });
  return pending.promise.finally(() => {
    clearTimeout(timeout);
    unsubscribe();
  });
}

const dataDir = await mkdtemp(join(tmpdir(), "oacc-live-omp-"));
const config = loadConfig({
  organizationName: "Verification Project",
  ownerDisplayName: "Verification Owner",
  dataDir,
  databasePath: join(dataDir, "control-center.sqlite3"),
  environment: "production",
  fakeOmpAllowed: false,
  port: 4317,
});
const center = new ControlCenter(config);

try {
  await center.initialize();
  const session = await center.startIdleAgent("DIR-COMMS");
  const assistantOutput = waitForEvent(
    center,
    (event) =>
      event.kind === "event" &&
      event.event?.type === "assistant.message" &&
      event.event.sessionId === session.sessionId,
    "assistant output",
  );
  const idle = waitForEvent(
    center,
    (event) =>
      event.kind === "event" &&
      event.event?.type === "session.idle" &&
      event.event.sessionId === session.sessionId,
    "terminal agent event",
  );

  await center.supervisor.sendInteractiveMessage(
    "DIR-COMMS",
    "Reply with exactly READY. Do not call a tool and do not perform any external action.",
  );
  const [outputEvent] = await Promise.all([assistantOutput, idle]);
  const output = outputEvent.event?.summary ?? "";
  if (output.trim() !== "READY") {
    throw new Error(`Live OMP smoke returned an unexpected bounded response: ${output}`);
  }
  const effective = center.store.database
    .prepare(
      "SELECT effective_provider AS provider, effective_model AS model, reasoning, model_policy_version AS policyVersion FROM sessions WHERE session_id = ?",
    )
    .get(session.sessionId) as {
    provider: string;
    model: string;
    reasoning: string;
    policyVersion: string;
  };
  process.stdout.write(
    `Live OMP smoke passed: ${effective.provider}/${effective.model}, reasoning=${effective.reasoning}, policy=${effective.policyVersion}, response=${output}\n`,
  );
} finally {
  await center.shutdown();
  await rm(dataDir, { recursive: true, force: true });
}
