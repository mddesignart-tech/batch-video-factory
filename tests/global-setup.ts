import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { applyTestEnv, ROOT, TEST_DATA } from "./test-env";

/**
 * Runs exactly once for the whole suite.
 *
 * The wipe and the schema push must not live in `setupFiles`: those run before
 * every test *file*, and on Windows deleting the data directory while another
 * file's Prisma connection still holds the database open fails with EPERM.
 */
export default function globalSetup(): void {
  applyTestEnv();

  fs.rmSync(TEST_DATA, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA, { recursive: true });

  // The Prisma CLI's JS entry point is invoked directly rather than through
  // `npx`: on Windows `npx` is a .cmd shim that execFileSync cannot launch
  // without a shell, and spawning a shell here would be both slower and an
  // injection surface for the paths above.
  execFileSync(
    process.execPath,
    [
      require.resolve("prisma/build/index.js"),
      "db",
      "push",
      "--skip-generate",
      "--accept-data-loss",
    ],
    { cwd: ROOT, stdio: "pipe", env: process.env },
  );
}
