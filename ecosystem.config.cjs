/**
 * PM2 configuration.
 *
 * `fork` with one instance, deliberately — not `cluster`. Two reasons, and the
 * first is the one that matters:
 *
 *   The realtime hub holds its subscribers in a Map inside the process. A
 *   second instance would have its own Map and would not see the first one's
 *   published events, so roughly half of all connected clients would silently
 *   stop receiving updates. Clustering this app requires a shared backplane
 *   first (Redis pub/sub behind `publish`, or a MongoDB change stream) — see
 *   the note in src/modules/realtime/hub.ts.
 *
 *   The scheduler's timer would also run per instance. That one is already
 *   handled: `runSchedulerLocked` takes a MongoDB lease, so overlapping passes
 *   are skipped rather than duplicated. The lock exists precisely so this
 *   decision is reversible.
 *
 * One Node process is comfortably enough for a single-institution pilot. The
 * ceiling is documented rather than hidden.
 */
module.exports = {
  apps: [
    {
      name: "gosaath-api",
      script: "dist/app/server.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,

      // The app reads .env itself through dotenv, so secrets stay in one file
      // owned by one user rather than being copied into PM2's process list,
      // where `pm2 describe` would print them.
      env: {
        NODE_ENV: "production",
      },

      // Restart on crash, but give up if it is crash-looping: a process that
      // cannot start is better left down and visible than restarted forever
      // while /health/ready lies about being reachable.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 2000,

      // SIGTERM first, and enough time to mean it. Shutdown hangs up the event
      // streams, finishes in-flight requests and closes MongoDB; killing it at
      // the default 1.6 seconds would cut that short on every deploy.
      kill_timeout: 15000,
      // Wait for the app to say it is listening rather than assuming it is up.
      wait_ready: false,
      listen_timeout: 10000,

      // A leak should restart the process rather than exhaust the box. Well
      // above normal working set for this app; if it is ever reached, that is
      // a bug worth seeing in the restart count.
      max_memory_restart: "600M",

      // Pino writes structured JSON to stdout. PM2 captures it; nothing here
      // reformats it, so `pm2 logs` and any log shipper see the same lines.
      merge_logs: true,
      time: false,
      out_file: "var/log/api.out.log",
      error_file: "var/log/api.err.log",
    },
  ],
};
