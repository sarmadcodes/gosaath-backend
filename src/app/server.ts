import { buildApp } from "./app.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { connectToDatabase, disconnectFromDatabase } from "../db/mongodb.js";
import { runScheduler } from "../modules/commutes/scheduler.service.js";
import { closeAll } from "../modules/realtime/hub.js";

/**
 * Process entry point: boot, then shut down cleanly.
 *
 * The shutdown path matters as much as the boot one. Under PM2 or a container
 * orchestrator, SIGTERM arrives during every deploy — a process that exits
 * immediately drops in-flight requests, and one that never exits gets killed
 * with SIGKILL a few seconds later, which does the same thing more rudely.
 */

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const app = await buildApp();

  // The database is connected before listening, but a failure here is not
  // fatal: the driver keeps retrying and /health/ready reports 503 until it
  // succeeds. Exiting instead would crash-loop the whole service over a
  // database that is merely slow to come up.
  try {
    await connectToDatabase();
  } catch (error) {
    logger.error(
      { err: error },
      "initial database connection failed; starting anyway and reporting not-ready",
    );
  }

  // The recurring engine. Rides have to appear, be confirmed and be reminded
  // about whether or not anybody opens the app, so the default deployment
  // does not depend on somebody remembering to set up cron. Set
  // SCHEDULER_INTERVAL_MIN=0 where cron runs `npm run scheduler` instead.
  let schedulerTimer: NodeJS.Timeout | undefined;
  if (env.SCHEDULER_INTERVAL_MIN > 0) {
    const tick = () => {
      // Never awaited by anything that serves a request, and never allowed to
      // throw into the process: a failed pass is logged and retried next tick.
      void runScheduler().catch((error: unknown) => {
        logger.error({ err: error }, "scheduler pass failed");
      });
    };
    schedulerTimer = setInterval(tick, env.SCHEDULER_INTERVAL_MIN * 60_000);
    // Does not hold the process open on its own during shutdown.
    schedulerTimer.unref();
    tick();
    logger.info({ everyMinutes: env.SCHEDULER_INTERVAL_MIN }, "scheduler started");
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(
    { port: env.PORT, host: env.HOST, env: env.NODE_ENV, tz: env.TZ },
    "gosaath-backend listening",
  );

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    // A second Ctrl-C should not start a second teardown halfway through the
    // first one.
    if (shuttingDown) {
      logger.warn({ signal }, "shutdown already in progress");
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    // Stop starting new passes. One already running finishes on its own, and
    // is safe to lose halfway: every step claims its work atomically, so the
    // next pass picks up whatever this one did not finish.
    if (schedulerTimer) clearInterval(schedulerTimer);

    // Never hang forever waiting on a stuck connection. Exiting on our own
    // terms is better than being SIGKILLed mid-write.
    const guard = setTimeout(() => {
      logger.fatal("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    guard.unref();

    try {
      // Hang up the event streams first. They are in-flight requests that
      // never complete on their own, so `app.close()` would wait for them
      // until the guard above fired. Clients treat the close as an ordinary
      // disconnect and reconnect with Last-Event-ID.
      closeAll();

      // Order matters: stop taking new work and let in-flight requests
      // finish, then close what they depend on. Closing Mongo first would
      // fail the very requests we are waiting for.
      await app.close();
      await disconnectFromDatabase();
      clearTimeout(guard);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (error) => {
    // The process is in an unknown state; keeping it alive risks serving
    // corrupt responses. Log, then let the supervisor restart it.
    logger.fatal({ err: error }, "uncaught exception");
    void shutdown("uncaughtException");
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
