import { beforeEach, describe, expect, it } from "vitest";
import {
  closeAll,
  connectionCount,
  publish,
  resetHub,
  subscribe,
} from "../../src/modules/realtime/hub.js";
import type { RealtimeEvent } from "../../src/modules/realtime/events.js";

/**
 * The hub, and specifically the part that is easy to get wrong.
 *
 * Delivering an event to a connected client is the simple half. The half that
 * decides whether the product actually works is what happens when a client
 * was NOT connected: a phone that went through a tunnel must come back either
 * knowing exactly what it missed, or knowing that it cannot know. Anything in
 * between — "probably nothing happened" — leaves somebody looking at a screen
 * that is quietly wrong, which is the entire bug this layer exists to remove.
 */

type Received = { id: number; event: RealtimeEvent };

function listener(channels: Parameters<typeof subscribe>[0]["channels"], lastEventId: number | null = null) {
  const received: Received[] = [];
  let ended = false;
  const subscription = subscribe({
    channels,
    lastEventId,
    send: (id, event) => received.push({ id, event }),
    end: () => {
      ended = true;
    },
  });
  return { received, subscription, ended: () => ended };
}

const alice = { kind: "user" as const, userId: "alice" };
const bob = { kind: "user" as const, userId: "bob" };

beforeEach(() => {
  resetHub();
});

describe("delivery", () => {
  it("sends an event to the channel it was published on", () => {
    const client = listener([alice]);

    publish(alice, { type: "ride.updated", rideId: "r1" });

    expect(client.received).toHaveLength(1);
    expect(client.received[0]!.event).toEqual({ type: "ride.updated", rideId: "r1" });
  });

  it("never sends one person's event to another person", () => {
    const hers = listener([alice]);
    const his = listener([bob]);

    publish(alice, { type: "seatRequest.created", requestId: "q1", rideId: "r1" });

    expect(hers.received).toHaveLength(1);
    expect(his.received).toHaveLength(0);
  });

  it("reaches every device the same person has open", () => {
    const phone = listener([alice]);
    const tablet = listener([alice]);

    publish(alice, { type: "notification.created", unread: 3 });

    expect(phone.received).toHaveLength(1);
    expect(tablet.received).toHaveLength(1);
  });

  it("stops sending once a connection closes", () => {
    const client = listener([alice]);
    client.subscription.close();

    publish(alice, { type: "ride.updated", rideId: "r1" });

    expect(client.received).toHaveLength(0);
  });

  it("keeps delivering to the others when one connection is broken", () => {
    const broken = subscribe({
      channels: [alice],
      lastEventId: null,
      send: () => {
        throw new Error("socket is gone");
      },
      end: () => {},
    });
    const working = listener([alice]);

    publish(alice, { type: "ride.updated", rideId: "r1" });

    expect(working.received).toHaveLength(1);
    broken.close();
  });
});

describe("reconnecting", () => {
  it("hands back exactly what was missed while away", () => {
    const first = listener([alice]);
    publish(alice, { type: "ride.updated", rideId: "r1" });
    const seen = first.received[0]!.id;
    first.subscription.close();

    // Offline. Two things happen.
    publish(alice, { type: "ride.confirmed", rideId: "r1" });
    publish(alice, { type: "notification.created", unread: 1 });

    const resumed = listener([alice], seen);

    expect(resumed.subscription.missed).toHaveLength(2);
    expect(resumed.subscription.missed!.map((entry) => entry.event.type)).toEqual([
      "ride.confirmed",
      "notification.created",
    ]);
  });

  it("returns nothing when genuinely nothing happened", () => {
    const first = listener([alice]);
    publish(alice, { type: "ride.updated", rideId: "r1" });
    const seen = first.received[0]!.id;
    first.subscription.close();

    const resumed = listener([alice], seen);

    expect(resumed.subscription.missed).toEqual([]);
  });

  it("admits it cannot fill the gap when history has aged out", () => {
    // More events than the buffer holds, so the earliest are gone.
    for (let i = 0; i < 80; i += 1) {
      publish(alice, { type: "ride.updated", rideId: `r${i}` });
    }

    // Resuming from the very first event, which is no longer buffered.
    const resumed = listener([alice], 1);

    // null, not an incomplete list. The route turns this into `resync`.
    expect(resumed.subscription.missed).toBeNull();
  });

  it("admits it cannot fill the gap after a restart", () => {
    // A client resuming with an id from a previous process: the sequence
    // began again at zero, so its id is in our future.
    const resumed = listener([alice], 5_000);

    expect(resumed.subscription.missed).toBeNull();
  });

  it("orders a replay across two channels by when things happened", () => {
    const admin = { kind: "institution" as const, institutionId: "szabist" };

    const first = listener([alice, admin]);
    publish(alice, { type: "ride.updated", rideId: "r1" });
    const seen = first.received[0]!.id;
    first.subscription.close();

    publish(admin, { type: "admin.report.created", open: 2 });
    publish(alice, { type: "ride.confirmed", rideId: "r1" });
    publish(admin, { type: "admin.verification.created", pending: 5 });

    const resumed = listener([alice, admin], seen);

    expect(resumed.subscription.missed!.map((entry) => entry.event.type)).toEqual([
      "admin.report.created",
      "ride.confirmed",
      "admin.verification.created",
    ]);
  });

  it("gives a first-time client no history at all", () => {
    publish(alice, { type: "ride.updated", rideId: "r1" });

    // No Last-Event-ID: a fresh connection renders from its own fetches, and
    // replaying yesterday's events into it would be noise.
    const fresh = listener([alice], null);

    expect(fresh.subscription.missed).toEqual([]);
  });
});

describe("shutdown", () => {
  it("hangs up every connection exactly once", () => {
    const admin = { kind: "institution" as const, institutionId: "szabist" };
    // Subscribed to two channels: must be ended once, not twice.
    const both = listener([alice, admin]);
    const other = listener([bob]);

    expect(connectionCount()).toBe(2);

    closeAll();

    expect(both.ended()).toBe(true);
    expect(other.ended()).toBe(true);
    expect(connectionCount()).toBe(0);
  });
});
