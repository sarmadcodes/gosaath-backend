import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import { requireAdmin, requireAdminContext } from "../../middleware/admin.js";
import { logger } from "../../utils/logger.js";
import { unreadCount } from "../notifications/notification.service.js";
import { subscribe } from "./hub.js";
import type { Channel, RealtimeEvent } from "./events.js";

/**
 * The live stream.
 *
 * Server-Sent Events rather than WebSockets, because every event in the
 * catalogue travels server → client. Nothing needs a channel back: a passenger
 * accepting a seat sends an ordinary authorised POST, which already has
 * validation, rate limiting and an audit trail attached to it. Adding a
 * bidirectional protocol would mean rebuilding all of that inside a socket
 * handler for no gain. SSE is also plain HTTP, so it inherits the bearer token,
 * the CORS policy and the reverse proxy configuration exactly as they are.
 *
 * **Authentication.** The bearer token arrives in the Authorization header,
 * like every other request — never in the query string, where it would be
 * written to every access log and proxy cache between here and the phone. That
 * rules out the browser's built-in `EventSource`, which cannot set headers, so
 * both clients read the stream with streaming `fetch` instead. That is a
 * deliberate trade: a few dozen lines of client code in exchange for not
 * putting credentials in URLs.
 */

/** Proxies and mobile networks drop a connection that goes quiet. */
const HEARTBEAT_MS = 25_000;

/**
 * Also the client's reconnect signal.
 *
 * An access token lives fifteen minutes. Rather than discovering expiry as a
 * mid-stream failure, the server closes the stream before then and the client
 * reconnects with a fresh token — a reconnect it already knows how to handle,
 * on a path that is exercised constantly instead of once a fortnight.
 */
const MAX_STREAM_MS = 10 * 60_000;

async function openStream(
  request: FastifyRequest,
  reply: FastifyReply,
  channels: Channel[],
  hello: () => Promise<RealtimeEvent | null>,
): Promise<void> {
  const lastEventHeader = request.headers["last-event-id"];
  const parsed = Number(Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader);
  const lastEventId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx buffers proxied responses by default, which for a stream means
    // events arrive in batches when the buffer fills — or never.
    "X-Accel-Buffering": "no",
  });

  // This response is meant to stay open. Node's socket timeout would close it
  // as an idle connection.
  request.raw.setTimeout(0);

  let open = true;

  function write(id: number | null, event: RealtimeEvent): void {
    if (!open) return;
    const lines = [
      ...(id === null ? [] : [`id: ${id}`]),
      `event: ${event.type}`,
      `data: ${JSON.stringify(event)}`,
      "",
      "",
    ];
    reply.raw.write(lines.join("\n"));
  }

  const subscription = subscribe({
    channels,
    lastEventId,
    send: write,
    end: () => {
      close();
      reply.raw.end();
    },
  });

  // Told to refetch, or handed exactly what was missed. Never left to assume.
  if (subscription.missed === null) {
    write(null, { type: "resync" });
  } else {
    for (const entry of subscription.missed) write(entry.id, entry.event);
  }

  // The current truth for the one piece of state a badge renders from, so a
  // client that has just connected does not have to fetch it separately.
  const opening = await hello().catch(() => null);
  if (opening) write(null, opening);

  const heartbeat = setInterval(() => {
    // A comment, not an event: it keeps the socket warm without the client
    // having to recognise a no-op message type.
    if (open) reply.raw.write(": ping\n\n");
  }, HEARTBEAT_MS);

  const lifetime = setTimeout(() => {
    close();
    reply.raw.end();
  }, MAX_STREAM_MS);

  function close(): void {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    subscription.close();
  }

  request.raw.on("close", close);
  request.raw.on("error", (error) => {
    logger.debug({ err: error }, "realtime stream error");
    close();
  });
}

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A member's stream.
   *
   * One channel: their own. A member never receives an event about anybody
   * else, which is why no event here needs a scope check of its own.
   */
  app.get(
    "/events",
    {
      preHandler: authenticate,
      // A stream is one request that lasts ten minutes. The global limiter
      // counts requests per minute, so reconnects — not traffic — are what it
      // would be measuring. Left generous enough for an app resuming from
      // background repeatedly on a flaky train journey.
      config: { rateLimit: { max: 60, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const { id } = requireUser(request);
      await openStream(request, reply, [{ kind: "user", userId: id }], async () => ({
        type: "notification.created",
        unread: await unreadCount(id),
      }));
      return reply;
    },
  );

  /**
   * An administrator's stream.
   *
   * Scoped from the server's view of who they are, never from anything the
   * client asks for: a university admin subscribing to another institution's
   * channel is not refused here, it is simply not expressible. The scope comes
   * from `requireAdmin`, which reads the role from the database on every
   * request — so an admin whose access was revoked loses the stream on their
   * next reconnect rather than keeping a live feed of an institution they no
   * longer administer.
   */
  app.get(
    "/admin/events",
    {
      preHandler: requireAdmin,
      config: { rateLimit: { max: 60, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const admin = requireAdminContext(request);
      const channels: Channel[] =
        admin.scope.kind === "platform"
          ? [{ kind: "platform" }, { kind: "user", userId: admin.userId }]
          : [
              { kind: "institution", institutionId: admin.scope.institutionId },
              { kind: "user", userId: admin.userId },
            ];

      await openStream(request, reply, channels, async () => null);
      return reply;
    },
  );
}
