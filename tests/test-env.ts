import path from "node:path";

/**
 * Shared test paths.
 *
 * Kept separate so the global setup (which runs once, in its own process) and
 * the per-file setup (which runs before every test file) cannot disagree about
 * where the throwaway database and data directory live.
 */

export const ROOT = path.resolve(__dirname, "..");
export const TEST_DATA = path.join(ROOT, "data", ".test");
export const TEST_DB = path.join(TEST_DATA, "test.db");

/** Prisma resolves a relative `file:` URL against the schema folder. */
export const TEST_DATABASE_URL = `file:${path
  .relative(path.join(ROOT, "prisma"), TEST_DB)
  .split(path.sep)
  .join("/")}`;

export function applyTestEnv(): void {
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
