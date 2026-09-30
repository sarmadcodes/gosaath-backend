import { logger } from "../../utils/logger.js";
import { channelKey, type Channel, type RealtimeEvent } from "./events.js";

/**
 * The live event hub.
 *
 * Publishers call `publish(channel, event)` and know nothing about
 * connections. Connections call `subscribe` and know nothing about who
 * publishes. In between sits a map of channel key to open connections, and a
 * small replay buffer so a client that drops off a train and comes back does
 * not have to be told "refetch everything" for the sake of two events.
 *
 * **In-process, deliberately.** One Node process holds every connection, so a
 * Map is the whole implementation — no Redis, no broker, nothing to operate.
 * That is the right size for a single-VPS pilot and it is a real ceiling: a
 * second instance would have its own Map and would not see the first one's
 * events. The seam for that is `publish`, and only `publish` — swapping the
 * body for a Redis pub/sub fan-out (or a MongoDB change stream) leaves every
 * caller and every client untouched. See docs/DEPLOYMENT.md.
 */

/** One open connection. */
type Subscriber = {
  id: number;
  /** Called for each event. Never throws: a broken write closes the socket. */
  send: (id: number, event: RealtimeEvent) => void;
  /**
   * Ends the underlying response.
   *
   * Held by the hub so shutdown can hang up, which is not optional: Fastify's
   * `close()` waits for in-flight requests to finish, and an event stream is
   * an in-flight request that by design never finishes. Without this, every
   * deploy would sit through the shutdown timeout and then be killed
   * mid-write.
   */
  end: () => void;
};

type BufferedEvent = {
  id: number;
  at: number;
  event: RealtimeEvent;
};

/**
 * How much history a channel keeps for reconnecting clients.
 *
 * Small on purpose. This is a courtesy for a connection that blinked, not a
 * message queue: anything longer and a client that was asleep for an hour
 * would be handed a hundred stale events instead of the one honest answer,
 * which is "refetch". Memory is bounded by channels × 64 regardless of how
 * busy the server gets.
 */
const REPLAY_LIMIT = 64;
const REPLAY_MAX_AGE_MS = 5 * 60_000;

const subscribers = new Map<string, Set<Subscriber>>();
const replay = new Map<string, BufferedEvent[]>();

/**
 * Monotonic across the whole process, not per channel.
 *
 * A client resuming with `Last-Event-ID` sends one number, and it may be
 * subscribed to two channels (a member who is also an admin). One sequence
 * means that number is comparable everywhere.
 */
let sequence = 0;

let nextSubscriberId = 1;

export function publish(channel: Channel, event: RealtimeEvent): void {
  const key = channelKey(channel);
  const id = ++sequence;

  const buffer = replay.get(key) ?? [];
  buffer.push({ id, at: Date.now(), event });
  if (buffer.length > REPLAY_LIMIT) buffer.splice(0, buffer.length - REPLAY_LIMIT);
  replay.set(key, buffer);

  const listeners = subscribers.get(key);
  if (!listeners || listeners.size === 0) return;

  for (const subscriber of listeners) {
    try {
      subscriber.send(id, event);
    } catch (error) {
      // A subscriber that cannot be written to is already gone; the route's
      // own close handler removes it. Never let one dead connection stop the
      // event reaching the others.
      logger.debug({ err: error, key }, "realtime send failed");
    }
  }
}

/** Publishes the same event to several channels, in one call. */
export function publishAll(channels: Channel[], event: RealtimeEvent): void {
  for (const channel of channels) publish(channel, event);
}

export type Subscription = {
  /** Events the client missed, or null when it cannot be told honestly. */
  missed: Array<{ id: number; event: RealtimeEvent }> | null;
  close: () => void;
};

/**
 * Opens a subscription to one or more channels.
 *
 * `lastEventId` is what the client last processed. If every requested channel
 * can account for everything after it, the gap is returned and the client
 * carries on seamlessly. If any channel cannot — the id is older than its
 * buffer, or from a previous process — `missed` is null and the caller sends
 * a `resync` instead. Guessing is not an option here: a client told "nothing
 * happened" when something did stays wrong until the person reloads, which is
 * precisely the bug this whole layer exists to remove.
 */
export function subscribe(input: {
  channels: Channel[];
  lastEventId: number | null;
  send: (id: number, event: RealtimeEvent) => void;
  end: () => void;
}): Subscription {
  const subscriber: Subscriber = {
    id: nextSubscriberId++,
    send: input.send,
    end: input.end,
  };
  const keys = input.channels.map(channelKey);

  for (const key of keys) {
    const set = subscribers.get(key) ?? new Set<Subscriber>();
    set.add(subscriber);
    subscribers.set(key, set);
  }

  const missed =
    input.lastEventId === null ? [] : replayAfter(keys, input.lastEventId);

  return {
    missed,
    close: () => {
      for (const key of keys) {
        const set = subscribers.get(key);
        if (!set) continue;
        set.delete(subscriber);
        // An empty set for every institution that ever had an admin online is
        // a slow leak. Dropped, along with its replay buffer's relevance.
        if (set.size === 0) subscribers.delete(key);
      }
    },
  };
}

function replayAfter(
  keys: string[],
  lastEventId: number,
): Array<{ id: number; event: RealtimeEvent }> | null {
  // An id from the future means a restart: the sequence began again at zero,
  // so this client's id belongs to a process that no longer exists and we
  // know nothing about what it saw.
  if (lastEventId > sequence) return null;

  const cutoff = Date.now() - REPLAY_MAX_AGE_MS;
  const gathered: Array<{ id: number; event: RealtimeEvent }> = [];

  for (const key of keys) {
    const buffer = (replay.get(key) ?? []).filter((entry) => entry.at >= cutoff);
    const oldest = buffer[0];

    // Nothing buffered at all: either the channel has been quiet, or its
    // history aged out. Quiet is the common case and is safe — there is
    // nothing after `lastEventId` to miss.
    if (!oldest) continue;

    // The buffer starts after the client's position, so whatever happened in
    // between has been forgotten. We cannot honestly fill the gap.
    if (oldest.id > lastEventId + 1) return null;

    for (const entry of buffer) {
      if (entry.id > lastEventId) gathered.push({ id: entry.id, event: entry.event });
    }
  }

  // Interleaved from several channels, so the client processes them in the
  // order they actually happened.
  return gathered.sort((a, b) => a.id - b.id);
}

/** How many connections are open, for /health/ready and for tests. */
export function connectionCount(): number {
  const seen = new Set<number>();
  for (const set of subscribers.values()) {
    for (const subscriber of set) seen.add(subscriber.id);
  }
  return seen.size;
}

/**
 * Drops every connection, for shutdown.
 *
 * SIGTERM has arrived and this process is going away. Closing the streams
 * makes each client reconnect — to the replacement instance, or to this one
 * once it is back — rather than sitting on a socket that will never speak
 * again and showing data that quietly goes stale.
 */
export function closeAll(): void {
  const closing = new Map<number, Subscriber>();
  // A subscriber on two channels appears twice; ended once.
  for (const set of subscribers.values()) {
    for (const subscriber of set) closing.set(subscriber.id, subscriber);
  }

  subscribers.clear();
  replay.clear();

  for (const subscriber of closing.values()) {
    try {
      subscriber.end();
    } catch (error) {
      logger.debug({ err: error }, "realtime close failed");
    }
  }

  logger.info({ connections: closing.size }, "closed realtime connections");
}

/** Test seam: forgets all state between cases. */
export function resetHub(): void {
  subscribers.clear();
  replay.clear();
  sequence = 0;
}
