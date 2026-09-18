import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * A single shared connection pool for the process.
 *
 * Never a client per request: each connection costs a socket and a server-side
 * session, and a pool opened per request exhausts both under any real load.
 */

export type DbStatus = "disconnected" | "connecting" | "connected" | "error";

let status: DbStatus = "disconnected";
let lastError: string | null = null;

mongoose.set("strictQuery", true);
// Autocreating a collection on first write hides a missing migration until
// production, where it appears as a collection with no indexes.
mongoose.set("autoCreate", false);
// Index creation belongs to an explicit, reviewable step, not to app boot.
mongoose.set("autoIndex", false);

export async function connectToDatabase(): Promise<void> {
  if (status === "connected" || status === "connecting") return;
  status = "connecting";

  const connection = mongoose.connection;

  connection.on("connected", () => {
    status = "connected";
    lastError = null;
    logger.info({ db: env.MONGODB_DB }, "mongodb connected");
  });

  connection.on("disconnected", () => {
    // Not fatal: the driver reconnects. Readiness flips so the orchestrator
    // stops routing traffic here until it does.
    status = "disconnected";
    logger.warn("mongodb disconnected");
  });

  connection.on("error", (error: Error) => {
    status = "error";
    lastError = error.message;
    logger.error({ err: error }, "mongodb error");
  });

  try {
    await mongoose.connect(env.MONGODB_URI, {
      dbName: env.MONGODB_DB,
      maxPoolSize: env.MONGODB_POOL_SIZE,
      minPoolSize: 2,
      // Fail fast rather than letting a request hang on an unreachable
      // primary until the client's own timeout.
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      // Writes are acknowledged by a majority, so an accepted seat cannot be
      // lost to a failover moments later.
      writeConcern: { w: "majority" },
      retryWrites: true,
    });
  } catch (error) {
    status = "error";
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export async function disconnectFromDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false);
  status = "disconnected";
  logger.info("mongodb connection closed");
}

export function databaseStatus(): DbStatus {
  // readyState is the truth; our own flag can lag an event.
  switch (mongoose.connection.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnected";
    default:
      return status === "error" ? "error" : "disconnected";
  }
}

export function databaseError(): string | null {
  return lastError;
}

/**
 * A real round trip, not just the socket state.
 *
 * A connection can read as open while the server is unable to serve, which is
 * exactly the case readiness exists to catch.
 */
export async function pingDatabase(timeoutMs = 2_000): Promise<boolean> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) return false;
  try {
    await Promise.race([
      admin.command({ ping: 1 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ping timeout")), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}
