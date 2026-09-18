/**
 * Verifies the SIGTERM path end to end.
 *
 * Not a vitest case: this has to spawn a real process and signal it, because
 * the whole point is what happens to a listening server, in-flight requests
 * and the Mongo pool — none of which exist under app.inject().
 */
import { spawn } from "node:child_process";

// Windows has no POSIX signals. libuv maps SIGTERM to TerminateProcess, so the
// handler never runs and an in-flight request is dropped — the exact failure
// this script exists to catch. There is no way to exercise the real path here,
// and adding a shutdown endpoint to work around it would be a hole in
// production. So it runs on the platform the service actually deploys to, and
// refuses to pretend otherwise on this one.
if (process.platform === "win32") {
  console.log("SKIPPED: graceful shutdown cannot be verified on Windows.");
  console.log("SIGTERM is a hard kill here, so the handler never runs.");
  console.log("Run this on Linux (CI or the deploy target) before shipping.");
  console.log("The shutdown path is UNVERIFIED until then.");
  process.exit(0);
}

const child = spawn(process.execPath, ["dist/app/server.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LOG_PRETTY: "false" },
});

let output = "";
const collect = (chunk) => { output += chunk.toString(); };
child.stdout.on("data", collect);
child.stderr.on("data", collect);

const listening = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("never started listening")), 20000);
  const check = () => {
    if (output.includes("gosaath-backend listening")) {
      clearTimeout(timer);
      resolve();
    }
  };
  child.stdout.on("data", check);
  child.stderr.on("data", check);
});

const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

await listening;
console.log("  started");

// An in-flight request at the moment the signal arrives is the case that
// separates a graceful shutdown from a process that just stops.
const inFlight = fetch("http://127.0.0.1:4000/health").then(
  (r) => r.status,
  () => "failed",
);

child.kill("SIGTERM");
console.log("  SIGTERM sent");

const status = await inFlight;
const { code, signal } = await exited;

const checks = [
  ["logged the signal",        /shutting down/.test(output)],
  ["completed teardown",       /shutdown complete/.test(output)],
  ["did not time out",         !/forcing exit/.test(output)],
  ["exited 0",                 code === 0],
  ["in-flight request served", status === 200],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`  exit=${code} signal=${signal} inFlight=${status}`);

if (failed) {
  console.log("\n--- output ---\n" + output.slice(-1500));
  process.exit(1);
}
console.log("\ngraceful shutdown OK");
