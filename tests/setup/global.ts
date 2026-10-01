import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Deletes data directories left behind by runs that were killed.
 *
 * mongodb-memory-server puts each mongod's data in its own `mongo-mem-*`
 * directory under the system temp folder and removes it on `stop()`. A run
 * that is interrupted — a timeout, Ctrl-C, a crashed worker — never reaches
 * `stop()`, and leaves roughly 200 MB behind.
 *
 * That is not a tidiness problem. Ten interrupted runs filled this machine's
 * disk to the point where mongod refused to start at all (it wants 500 MB
 * free), so the test suite broke in a way that looked like a code failure and
 * was not. Sweeping on the way in fixes it for every future run, including
 * ones interrupted in the future.
 *
 * Only directories older than an hour are touched, so a suite running in
 * another terminal is left alone.
 */
function sweepStaleDataDirs(): void {
  const root = tmpdir();
  const cutoff = Date.now() - 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("mongo-mem-") && !entry.startsWith("gosaath-mongo-")) continue;
    const path = join(root, entry);
    try {
      if (statSync(path).mtimeMs > cutoff) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // In use by another run, or already gone. Either is fine.
    }
  }
}

export async function setup(): Promise<void> {
  if (process.env["TEST_AGAINST_ATLAS"] === "1") {
    // The real cluster's URI lives in .env, which nothing has read yet here.
    loadDotenv();
  }
  let uri = process.env["MONGODB_URI"];

  if (process.env["TEST_AGAINST_ATLAS"] !== "1") {
    sweepStaleDataDirs();
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
  // Explicit cleanup rather than relying on the default: this is the call that
  // removes the data directory, and leaving it to chance is what filled the
  // disk in the first place.
  await replSet?.stop({ doCleanup: true, force: false });
  rmSync(URI_HANDOFF, { force: true });
}
