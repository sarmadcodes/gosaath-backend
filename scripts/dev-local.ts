import { MongoMemoryReplSet } from "mongodb-memory-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The whole backend, on this machine, with nothing external.
 *
 * Atlas is the shared development database, which makes it a single point of
 * failure for local work: when it is unreachable, or this machine's IP is not
 * on the allow list, nobody can run anything. This starts a MongoDB in
 * memory, seeds it, and runs the server against it.
 *
 * The data is thrown away when the process stops. That is the point: every
 * run starts from the same seeded state, so a test of the app or the admin
 * panel is never confused by something left behind yesterday.
 */

const run = promisify(execFile);

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const uri = replSet.getUri();

const env = {
  ...process.env,
  NODE_ENV: "development",
  MONGODB_URI: uri,
  MONGODB_DB: "gosaath_dev",
  LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
};

console.log("  local mongodb started, seeding...");

// Async spawns, never execFileSync: a blocking spawn freezes this process's
// event loop, the in-memory server's output pipe fills, and every write
// times out.
for (const script of ["seed.ts", "seed-demo.ts", "seed-admin.ts"]) {
  const { stdout } = await run(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", `scripts/${script}`],
    { env },
  );
  process.stdout.write(stdout);
}

console.log("  starting the server...\n");

const server = (await import("node:child_process")).spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "watch", "src/app/server.ts"],
  { env, stdio: "inherit" },
);

const stop = async () => {
  server.kill();
  await replSet.stop();
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", stop);
