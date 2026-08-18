import { rm } from "node:fs/promises";

await Promise.all([
  rm(new URL("../dist-web", import.meta.url), { force: true, recursive: true }),
  rm(new URL("../dist-server", import.meta.url), { force: true, recursive: true }),
]);
