import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared test paths.
 *
 * Kept separate so the global setup (which runs once, in its own process) and
 * the per-file setup (which runs before every test file) cannot disagree about
 * where the throwaway database and data directory live.
 */

export const ROOT = path.resolve(__dirname, "..");

/**
 * Environment variable that overrides where test runs keep their folders.
 */
export const TEST_ROOT_ENV = "VIDEO_FACTORY_TEST_ROOT";

/**
 * Parent of every test run's private folder.
 *
 * It lives in the OS temp folder, not under `data/`: on this machine the repo
 * sits on a spinning disk (F:) and the temp folder on an NVMe SSD (C:). Every
 * SQLite commit fsyncs, and every render writes and reads back MP4/WAV/PNG
 * files, so the same suite measured ~2.5x slower on the HDD (2026-10-17: one
 * pipeline test 225 s on F: vs 90 s on C:). The folder is a throwaway either
 * way. `realpathSync.native` expands the 8.3 short name (`MINDDE~1`) so paths
 * compare equal to what the app resolves later.
 */
export const TEST_ROOT =
  process.env[TEST_ROOT_ENV] ??
  path.join(fs.realpathSync.native(os.tmpdir()), "video-factory-test");

/**
 * Environment variable that carries THIS run's folder from the global setup
 * (main process) to the test workers (forks, which inherit the environment).
 */
export const TEST_RUN_ENV = "VIDEO_FACTORY_TEST_DATA";

/**
 * One folder per vitest process. It used to be the fixed `data/.test`, and the
 * global setup wipes its folder at start - so a second vitest started while a
 * suite was running deleted that suite's database and media mid-run (seen
 * 2026-09-26: a pipeline.e2e render lost its FFmpeg input, QĐ-109). Now each
 * run owns `<TEST_ROOT>/run-<pid>-<id>` and touches nothing else.
 */
export const TEST_DATA =
  process.env[TEST_RUN_ENV] ??
  path.join(TEST_ROOT, `run-${process.pid}-${Date.now().toString(36)}`);
export const TEST_DB = path.join(TEST_DATA, "test.db");

/**
 * Prisma resolves a relative `file:` URL against the schema folder. When the
 * test folder is on another drive, `path.relative` returns an absolute path,
 * which Prisma (and `resolveDatabaseFile`) take as is.
 */
// socket_timeout: a busy test machine renders several 1080x1920 videos at once
// (per-video runs, QĐ-110); the default wait for SQLite is too short for that.
export const TEST_DATABASE_URL = `file:${path
  .relative(path.join(ROOT, "prisma"), TEST_DB)
  .split(path.sep)
  .join("/")}?socket_timeout=60`;

export function applyTestEnv(): void {
  process.env[TEST_RUN_ENV] = TEST_DATA;
  process.env.DATA_DIR = TEST_DATA;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  // The master safety switch, pinned on: no test may ever reach a paid API.
  process.env.AI_MOCK_MODE = "true";
  // The background worker must not race the test harness for jobs.
  process.env.JOB_WORKER_ENABLED = "false";
  process.env.SECRET_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.MOCK_FAILURE_RATE;
  // Test files share ONE database and reuse the same mock storyboards; with the
  // production default (GLOBAL) a file would reuse another file's purchases.
  // Each file stays independent; the asset-reuse suite opts into GLOBAL itself.
  process.env.ASSET_REUSE_SCOPE = "SCENE";
}
