import { ConfigurationModel } from "../db/models/index.js";
import { logger } from "./logger.js";

/**
 * A lock, held in MongoDB.
 *
 * The recurring engine must run, and must not run twice. Once is guaranteed by
 * the interval; not-twice is the harder half, because "twice" has three
 * separate causes:
 *
 *   two app instances behind the load balancer, each with its own timer
 *   a cron entry running `npm run scheduler` while an instance also has one
 *   a deploy where the old process has not exited before the new one starts
 *
 * The scheduler's own writes are idempotent, so none of these corrupts data —
 * but two passes generating the same week of rides is duplicated work, and two
 * passes draining the push outbox is a race that the outbox then has to win on
 * every row. Cheaper to hold a lock.
 *
 * **MongoDB rather than Redis** because MongoDB is already here. A lock is not
 * worth an extra service to operate, and this one is a single atomic
 * findOneAndUpdate: the filter is the condition for taking it, so two callers
 * arriving together cannot both match.
 *
 * It is an advisory lock with a lease, not a guarantee. A process that is
 * paused for longer than the lease can still be holding it in its own mind
 * while another takes it — which is why the work under it stays idempotent.
 * The lock is an optimisation on top of correctness, never a substitute.
 */

type LockResult<T> = { ran: true; value: T } | { ran: false; value: null };

/**
 * Runs `work` if this process can take the named lock.
 *
 * The lease is what makes a crash survivable: a holder that dies without
 * releasing blocks others only until it expires, so pick a lease comfortably
 * longer than the work takes and comfortably shorter than how long an outage
 * may go unnoticed.
 */
export async function withLock<T>(
  name: string,
  leaseMs: number,
  work: () => Promise<T>,
): Promise<LockResult<T>> {
  const key = `lock:${name}`;
  const now = new Date();
  const until = new Date(now.getTime() + leaseMs);

  // Taken only if nobody holds it or the previous lease has expired. Both
  // conditions live in the filter, so the decision and the write are one
  // operation and there is no window between checking and taking.
  const taken = await ConfigurationModel.findOneAndUpdate(
    {
      key,
      $or: [{ "value.until": { $lte: now } }, { "value.until": { $exists: false } }],
    },
    { $set: { key, value: { until, by: process.pid } } },
    { upsert: true, new: true },
  ).catch((error: unknown) => {
    // A duplicate key means another process inserted the row in the moment
    // between our filter missing it and our upsert. That process holds the
    // lock, which is exactly the answer we wanted.
    if ((error as { code?: number }).code === 11000) return null;
    throw error;
  });

  if (!taken) return { ran: false, value: null };

  try {
    return { ran: true, value: await work() };
  } finally {
    // Released early, so the next run does not wait out the whole lease. A
    // failure to release is harmless: the lease expires on its own.
    await ConfigurationModel.updateOne(
      { key, "value.by": process.pid },
      { $set: { "value.until": new Date(0) } },
    ).catch((error: unknown) => {
      logger.warn({ err: error, lock: name }, "could not release lock");
    });
  }
}
