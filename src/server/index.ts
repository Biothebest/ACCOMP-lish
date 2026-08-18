import { loadConfig } from "./config.js";
import { ControlCenter } from "./control-center.js";
import { buildHttpServer } from "./http.js";
import { acquireControllerLock } from "./process-lock.js";
import { sanitizeError } from "./security.js";

const config = loadConfig();
const processLock = acquireControllerLock(config.dataDir);
const controlCenter = new ControlCenter(config);
await controlCenter.initialize();
const server = await buildHttpServer(controlCenter);
let closing = false;

const shutdown = async (signal: string): Promise<void> => {
  if (closing) {
    return;
  }
  closing = true;
  controlCenter.store.recordEvent({
    type: "controller.shutdown",
    summary: `Controller shutdown requested by ${signal}`,
    severity: "warning",
  });
  try {
    const closingServer = server.close();
    controlCenter.events.shutdown();
    await closingServer;
  } finally {
    try {
      await controlCenter.shutdown();
    } finally {
      processLock.release();
    }
  }
};

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});

try {
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  const safe = sanitizeError(error);
  console.error(`ACCOMP-lish failed to start: ${safe.summary}`);
  try {
    await controlCenter.shutdown();
  } finally {
    processLock.release();
  }
  process.exitCode = 1;
}
