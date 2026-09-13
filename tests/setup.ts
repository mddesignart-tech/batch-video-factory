import { applyTestEnv } from "./test-env";

/**
 * Per-test-file setup.
 *
 * Environment only - it must stay side-effect free. The database is created once
 * in `tests/global-setup.ts`; recreating it here would tear the file out from
 * under whichever test file is currently connected to it (EPERM on Windows).
 */
applyTestEnv();
