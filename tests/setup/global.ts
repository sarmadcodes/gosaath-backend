import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { config as loadDotenv } from "dotenv";

/**
 * Prepares the test database once per run.
 *
 * **Local by default.** The suite used to run against the shared Atlas
 * cluster, which made it slow — about 2.5 seconds per test, nearly all of it
 * network — and, worse, unrunnable whenever Atlas was unreachable or this
 * machine's IP was not on the allow list. A test suite that cannot be run is
 * not a safety net, so it now starts a MongoDB of its own.
 *
 * A replica set of one, because the product needs transactions: accepting a
 * seat writes the request, the attendance row and the seat count together, and
 * a standalone mongod cannot do that.
 *
 * Set `TEST_AGAINST_ATLAS=1` to use the real cluster instead — worth doing
 * before a release, since only that exercises the deployed configuration.
 *
 * Either way the seed is the real one from `scripts/seed.ts`, not a fixture:
 * a hand-written fixture drifts from the seed and the tests quietly stop
 * meaning anything.
 */

/** Where the worker processes read the URI from. See `tests/setup/env.ts`. */
export const URI_HANDOFF = join(tmpdir(), "gosaath-test-mongo-uri");

let replSet: MongoMemoryReplSet | undefined;
let dataDir: string | undefined;

export async function setup(): Promise<void> {
  if (process.env["TEST_AGAINST_ATLAS"] === "1") {
    // The real cluster's URI lives in .env, which nothing has read yet here.
    loadDotenv();
  }
  let uri = process.env["MONGODB_URI"];

  if (process.env["TEST_AGAINST_ATLAS"] !== "1") {
    dataDir = mkdtempSync(join(tmpdir(), "gosaath-mongo-"));
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    uri = replSet.getUri();
  }

  if (!uri) throw new Error("No MONGODB_URI for the test run.");

  // Workers are separate processes and inherit nothing set here, so the URI is
  // handed over on disk and read back in `tests/setup/env.ts`.
  writeFileSync(URI_HANDOFF, uri, "utf8");
  process.env["MONGODB_URI"] = uri;

  // Async, not execFileSync: a blocking spawn freezes this process's event
  // loop, and with it the pipes draining the in-memory mongod's output. The
  // server then stalls on a full pipe and every write times out.
  await promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/seed.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MONGODB_URI: uri,
      MONGODB_DB: "gosaath_test",
      LOG_LEVEL: "silent",
    },
  });
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  rmSync(URI_HANDOFF, { force: true });
}
