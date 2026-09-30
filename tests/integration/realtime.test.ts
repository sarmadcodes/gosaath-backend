import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  CampusModel,
  InstitutionModel,
  UserModel,
} from "../../src/db/models/index.js";
import { notify } from "../../src/modules/notifications/notification.service.js";
import type { RealtimeEvent } from "../../src/modules/realtime/events.js";

/**
 * The live stream, over a real socket.
 *
 * `app.inject` cannot exercise this: it buffers a response and resolves when
 * it ends, and this response is designed never to end. So the app listens on a
 * real port and these tests read the stream the way a phone does — which also
 * covers the parts only a real connection has, such as whether the
 * Authorization header is honoured and whether the framing an SSE client
 * expects is actually what we emit.
 */

let app: FastifyInstance;
let baseUrl: string;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string };

async function makeUser(email: string): Promise<Person> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: `${email.split("@")[0]} Person`,
      email,
      password: "a-long-enough-passphrase",
      phone: "0300 1234567",
      userType: "student",
      institutionId,
      campusId,
      areaId,
    },
  });
  if (reg.statusCode >= 400) throw new Error(`register ${reg.statusCode}: ${reg.body}`);
  await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "a-long-enough-passphrase" },
  });
  if (login.statusCode >= 400) throw new Error(`login ${login.statusCode}: ${login.body}`);
  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { token: login.json().data.token },
  });
  if (refresh.statusCode >= 400) throw new Error(`refresh ${refresh.statusCode}: ${refresh.body}`);

  const user = await UserModel.findOne({ email });
  return {
    access: refresh.json().data.accessToken as string,
    id: user!._id.toString(),
  };
}

/**
 * An SSE client, small enough to read.
 *
 * It parses the wire format rather than trusting it: blank-line separated
 * blocks of `id:` / `event:` / `data:` fields. If the server ever emits framing
 * a real client would reject, these tests stop seeing events.
 */
function open(path: string, token: string, lastEventId?: number) {
  const controller = new AbortController();
  const events: Array<{ id: number | null; event: RealtimeEvent }> = [];
  let buffer = "";
  let status = 0;

  const ready = (async () => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId ? { "last-event-id": String(lastEventId) } : {}),
      },
      signal: controller.signal,
    });

    status = response.status;
    if (!response.ok || !response.body) return;

    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const lines = block.split("\n");
            // A heartbeat is a comment and carries no data field.
            const data = lines.find((line) => line.startsWith("data: "));
            if (!data) continue;
            const idLine = lines.find((line) => line.startsWith("id: "));
            events.push({
              id: idLine ? Number(idLine.slice(4)) : null,
              event: JSON.parse(data.slice(6)) as RealtimeEvent,
            });
          }
        }
      } catch {
        // Aborted by the test, or the server hung up. Both are expected here.
      }
    })();
  })();

  return {
    ready,
    events,
    status: () => status,
    close: () => controller.abort(),
  };
}

/** Events arrive over a socket, so assertions have to be allowed to wait. */
async function waitFor<T>(
  check: () => T | undefined | false,
  what: string,
  timeoutMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  // Port 0: the OS picks a free one, so a developer already running the dev
  // server does not break the suite.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  institutionId = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  await app.close();
  await disconnectFromDatabase();
});

describe("who may open a stream", () => {
  it("refuses a request with no token", async () => {
    const response = await fetch(`${baseUrl}/events`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("refuses a token that is not a token", async () => {
    const response = await fetch(`${baseUrl}/events`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  it("refuses an ordinary member the admin stream", async () => {
    const member = await makeUser(`rt-member-${Date.now()}@szabist.edu.pk`);
    const response = await fetch(`${baseUrl}/admin/events`, {
      headers: { authorization: `Bearer ${member.access}` },
    });
    // Refused outright, not served-but-quiet: a stream that opens for anybody
    // and simply carries nothing is a stream that starts carrying something
    // the day a scope check moves.
    expect(response.status).toBe(403);
    await response.body?.cancel();
  });

  it("serves an event stream to a signed-in member", async () => {
    const member = await makeUser(`rt-ok-${Date.now()}@szabist.edu.pk`);
    const response = await fetch(`${baseUrl}/events`, {
      headers: { authorization: `Bearer ${member.access}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // nginx buffers proxied responses by default, which for a stream means
    // events arrive in batches when the buffer fills, or not at all.
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
  });
});

describe("delivery over the wire", () => {
  it("sends the current unread count on connect", async () => {
    const member = await makeUser(`rt-hello-${Date.now()}@szabist.edu.pk`);
    await notify({
      userId: member.id,
      kind: "rideReminder",
      title: "Tomorrow",
      body: "Your ride is at 08:00.",
    });

    const stream = open("/events", member.access);
    await stream.ready;

    const first = await waitFor(
      () => stream.events.find((entry) => entry.event.type === "notification.created"),
      "the opening unread count",
    );

    expect(first.event).toMatchObject({ type: "notification.created", unread: 1 });
    stream.close();
  });

  it("pushes a notification to an open stream without being asked", async () => {
    const member = await makeUser(`rt-live-${Date.now()}@szabist.edu.pk`);
    const stream = open("/events", member.access);
    await stream.ready;
    await waitFor(() => stream.events.length > 0, "the opening event");
    const before = stream.events.length;

    await notify({
      userId: member.id,
      kind: "seatRequest",
      title: "Someone asked for a seat",
      body: "A member would like a seat.",
    });

    const arrived = await waitFor(
      () => stream.events.length > before && stream.events[stream.events.length - 1],
      "a live notification",
    );

    expect(arrived.event).toMatchObject({ type: "notification.created", unread: 1 });
    // Carries an id, so a client that drops can resume from it.
    expect(arrived.id).toBeGreaterThan(0);
    stream.close();
  });

  it("never sends one member's events to another", async () => {
    const stamp = Date.now();
    const alice = await makeUser(`rt-a-${stamp}@szabist.edu.pk`);
    const bob = await makeUser(`rt-b-${stamp}@szabist.edu.pk`);

    const hers = open("/events", alice.access);
    const his = open("/events", bob.access);
    await Promise.all([hers.ready, his.ready]);
    await waitFor(() => his.events.length > 0, "bob's opening event");
    const bobBefore = his.events.length;

    await notify({
      userId: alice.id,
      kind: "seatRequest",
      title: "For Alice only",
      body: "Not for Bob.",
    });

    await waitFor(
      () => hers.events.some((entry) => entry.event.type === "notification.created"),
      "alice's event",
    );

    // The event reached Alice, so Bob has had ample time to receive it too.
    expect(his.events.length).toBe(bobBefore);

    hers.close();
    his.close();
  });

  it("tells a client to resync when it resumes from a forgotten position", async () => {
    const member = await makeUser(`rt-resync-${Date.now()}@szabist.edu.pk`);

    // An id from a process that no longer exists: far beyond our sequence.
    const stream = open("/events", member.access, 900_000);
    await stream.ready;

    const resync = await waitFor(
      () => stream.events.find((entry) => entry.event.type === "resync"),
      "a resync instruction",
    );

    expect(resync.event.type).toBe("resync");
    stream.close();
  });
});
