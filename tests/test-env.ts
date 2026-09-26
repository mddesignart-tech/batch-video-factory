import path from "node:path";

/**
 * Shared test paths.
 *
 * Kept separate so the global setup (which runs once, in its own process) and
 * the per-file setup (which runs before every test file) cannot disagree about
 * where the throwaway database and data directory live.
 */

export const ROOT = path.resolve(__dirname, "..");

/** Parent of every test run's private folder. */
export const TEST_ROOT = path.join(ROOT, "data", ".test");

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
 * run owns `data/.test/run-<pid>-<id>` and touches nothing else.
 */
export const TEST_DATA =
  process.env[TEST_RUN_ENV] ??
  path.join(TEST_ROOT, `run-${process.pid}-${Date.now().toString(36)}`);
export const TEST_DB = path.join(TEST_DATA, "test.db");

/** Prisma resolves a relative `file:` URL against the schema folder. */
export const TEST_DATABASE_URL = `file:${path
  .relative(path.join(ROOT, "prisma"), TEST_DB)
  .split(path.sep)
  .join("/")}`;

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
}
