import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { applyTestEnv, ROOT, TEST_DATA, TEST_ROOT } from "./test-env";

const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Folders left by runs that were killed (out of memory, Ctrl+C) before their
 * teardown. Only ones untouched for a day are removed, so a run that is still
 * going - in another terminal - is never disturbed. Anything locked is skipped.
 */
function removeStaleRuns(): void {
  if (!fs.existsSync(TEST_ROOT)) return;
  for (const name of fs.readdirSync(TEST_ROOT)) {
    const full = path.join(TEST_ROOT, name);
    if (full === TEST_DATA) continue;
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > STALE_MS) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // In use or already gone: not ours to fight over.
    }
  }
}

/**
 * Runs exactly once for the whole suite.
 *
 * The wipe and the schema push must not live in `setupFiles`: those run before
 * every test *file*, and on Windows deleting the data directory while another
 * file's Prisma connection still holds the database open fails with EPERM.
 *
 * It wipes ONLY this run's own folder (see TEST_DATA): a second vitest started
 * alongside can no longer delete a running suite's database and media.
 */
export default function globalSetup(): () => void {
  applyTestEnv();

  removeStaleRuns();
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

  // Teardown: this run's folder goes with it. Best effort - a handle still
  // closing on Windows leaves it for the stale sweep of a later run.
  return () => {
    try {
      fs.rmSync(TEST_DATA, { recursive: true, force: true });
    } catch {
      // left for removeStaleRuns
    }
  };
}
