import { execFileSync } from "node:child_process";

/**
 * Prepares the test database once per run.
 *
 * Runs the real seed rather than a fixture, so the assertions check what
 * production will actually contain. A hand-written fixture drifts from the
 * seed and the tests quietly stop meaning anything.
 */
export async function setup(): Promise<void> {
  execFileSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/seed.ts"],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "test",
        MONGODB_DB: "gosaath_test",
        LOG_LEVEL: "silent",
      },
    },
  );
}
