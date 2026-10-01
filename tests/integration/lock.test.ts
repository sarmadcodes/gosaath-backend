import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import { ConfigurationModel } from "../../src/db/models/index.js";
import { withLock } from "../../src/utils/lock.js";

/**
 * The scheduler lock.
 *
 * Three separate things can cause a second pass: two app instances each with
 * their own timer, a cron entry running alongside them, and a deploy where the
 * old process has not exited. The writes underneath are idempotent so none of
 * them corrupts anything — but two passes draining the push outbox is a race
 * the outbox then has to win on every row, and two generating the same week is
 * duplicated work.
 */

beforeAll(async () => {
  await connectToDatabase();
}, 60_000);

afterAll(async () => {
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await ConfigurationModel.deleteMany({ key: /^lock:/ });
});

describe("withLock", () => {
  it("runs the work and reports that it did", async () => {
    const result = await withLock("test-basic", 10_000, async () => 42);

    expect(result).toEqual({ ran: true, value: 42 });
  });

  it("lets only one of two simultaneous callers through", async () => {
    let running = 0;
    let concurrent = 0;

    const work = async () => {
      running += 1;
      concurrent = Math.max(concurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 60));
      running -= 1;
      return "done";
    };

    const [first, second] = await Promise.all([
      withLock("test-race", 10_000, work),
      withLock("test-race", 10_000, work),
    ]);

    // Exactly one ran, and the work was never inside itself.
    expect([first.ran, second.ran].filter(Boolean)).toHaveLength(1);
    expect(concurrent).toBe(1);
  });

  it("releases as soon as the work finishes, rather than waiting out the lease", async () => {
    // A long lease. If releasing did not happen, the second call would be
    // refused for ten minutes.
    await withLock("test-release", 10 * 60_000, async () => "first");
    const second = await withLock("test-release", 10 * 60_000, async () => "second");

    expect(second).toEqual({ ran: true, value: "second" });
  });

  it("releases even when the work throws", async () => {
    await expect(
      withLock("test-throw", 10 * 60_000, async () => {
        throw new Error("the pass failed");
      }),
    ).rejects.toThrow("the pass failed");

    // A failed pass must not lock the scheduler out until the lease expires.
    const next = await withLock("test-throw", 10 * 60_000, async () => "after");
    expect(next.ran).toBe(true);
  });

  it("recovers on its own after a holder dies without releasing", async () => {
    // A process that took the lock and vanished: the row still says held, with
    // a lease that has since passed.
    await ConfigurationModel.updateOne(
      { key: "lock:test-stale" },
      { $set: { key: "lock:test-stale", value: { until: new Date(Date.now() - 1_000), by: 9999 } } },
      { upsert: true },
    );

    const result = await withLock("test-stale", 10_000, async () => "recovered");

    expect(result).toEqual({ ran: true, value: "recovered" });
  });

  it("refuses while somebody else's lease is still running", async () => {
    await ConfigurationModel.updateOne(
      { key: "lock:test-held" },
      { $set: { key: "lock:test-held", value: { until: new Date(Date.now() + 60_000), by: 9999 } } },
      { upsert: true },
    );

    const result = await withLock("test-held", 10_000, async () => "should not run");

    expect(result).toEqual({ ran: false, value: null });
  });

  it("keeps separate locks separate", async () => {
    const [a, b] = await Promise.all([
      withLock("test-one", 10_000, async () => "a"),
      withLock("test-two", 10_000, async () => "b"),
    ]);

    expect(a.ran).toBe(true);
    expect(b.ran).toBe(true);
  });
});
