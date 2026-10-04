import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AttendanceModel,
  CampusModel,
  InstitutionModel,
  RideInstanceModel,
  UserModel,
} from "../../src/db/models/index.js";
import { closeAll } from "../../src/modules/realtime/hub.js";
import { runScheduler } from "../../src/modules/commutes/scheduler.service.js";
import type { RealtimeEvent } from "../../src/modules/realtime/events.js";

/**
 * The whole product, once, as two people actually use it.
 *
 * Every other test file proves one thing in isolation. This one walks the
 * journey end to end — two students, a match, a seat request, an acceptance, a
 * confirmed ride, a driver who cannot make it, and cover found — and asserts
 * something no unit test can: that **neither side ever has to refresh**.
 *
 * That last part is why this is worth its runtime. Each step below waits for
 * the event that should have arrived on the other person's live stream, and the
 * test fails if it does not. A screen that only updates when somebody pulls it
 * down would pass every other test in this suite and fail here.
 */

let app: FastifyInstance;
let baseUrl: string;
let institutionId: string;
let campusId: string;
let areaId: string;

type Person = { access: string; id: string; name: string };

const api = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

/**
 * Asserts a call succeeded, and says what the server actually objected to.
 *
 * A bare `expect(status).toBe(200)` in a sequence this long tells you only
 * that something broke somewhere, which is the least useful thing it could
 * say.
 */
function ok(response: { statusCode: number; body: string }, what: string) {
  if (response.statusCode >= 400) {
    throw new Error(`${what} failed (${response.statusCode}): ${response.body}`);
  }
  return response;
}

async function makeUser(email: string, name: string): Promise<Person> {
  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name,
      email,
      password: "a-long-enough-passphrase",
      phone: "0300 5551234",
      userType: "student",
      institutionId,
      campusId,
      areaId,
    },
  });
  if (registered.statusCode >= 400) throw new Error(`register: ${registered.body}`);

  await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "a-long-enough-passphrase" },
  });
  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { token: login.json().data.token },
  });

  const user = await UserModel.findOne({ email });
  return { access: refresh.json().data.accessToken as string, id: user!._id.toString(), name };
}

/** A live stream, read the way the app reads it. */
function listen(path: string, token: string) {
  const controller = new AbortController();
  const events: RealtimeEvent[] = [];
  let buffer = "";

  const ready = (async () => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`stream: ${response.status}`);

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
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = frame.split("\n").find((line) => line.startsWith("data: "));
            if (data) events.push(JSON.parse(data.slice(6)) as RealtimeEvent);
          }
        }
      } catch {
        // Aborted, or the server hung up. Both expected.
      }
    })();
  })();

  return {
    ready,
    events,
    /** Waits for an event of this type to arrive, and returns it. */
    async expect<T extends RealtimeEvent["type"]>(type: T, what: string) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = events.find((event) => event.type === type);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `${what}: no "${type}" arrived without a refresh. Saw: ` +
              `${[...new Set(events.map((e) => e.type))].join(", ") || "nothing"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => controller.abort(),
  };
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;

  institutionId = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  // Hang up before closing, exactly as production shutdown does: a stream is
  // an in-flight request that never ends on its own.
  closeAll();
  await app.close();
  await disconnectFromDatabase();
});

describe("two students, one commute, no refreshing", () => {
  it(
    "match -> request -> accept -> confirm -> driver unavailable -> replacement",
    async () => {
      const stamp = Date.now();

      // --- Both people exist -------------------------------------------------
      const driver = await makeUser(`e2e-driver-${stamp}@szabist.edu.pk`, "Bilal Ahmed");
      const rider = await makeUser(`e2e-rider-${stamp}@szabist.edu.pk`, "Sarmad Abbasi");

      // Streams open before anything happens, like two phones with the app in
      // the foreground. Nothing below ever polls.
      const driverPhone = listen("/events", driver.access);
      const riderPhone = listen("/events", rider.access);
      await Promise.all([driverPhone.ready, riderPhone.ready]);

      // --- A car -------------------------------------------------------------
      const vehicle = await api("PUT", "/vehicles", driver.access, {
        type: "car",
        model: "Toyota Corolla",
        plate: "BKT-512",
        colour: "White",
      });
      ok(vehicle, "saving the driver's car");
      const vehicleId = vehicle.json().data.id as string;

      // --- The driver offers, the rider is looking ---------------------------
      const SCHEDULE = [
        { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
        { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
      ];

      const offered = await api("POST", "/commutes", driver.access, {
        intent: "offer",
        direction: "both",
        campusId,
        originAreaId: areaId,
        schedule: SCHEDULE,
        vehicleId,
        seatsOffered: 3,
        contribution: 300,
        // Required by the schema, and always false: the preference was
        // withdrawn because nothing collects gender, so nothing could enforce
        // it. See SYSTEM.md.
        womenOnly: false,
      });
      ok(offered, "the driver offering a commute");
      const driverCommuteId = offered.json().data.id as string;

      const wanted = await api("POST", "/commutes", rider.access, {
        intent: "find",
        direction: "both",
        campusId,
        originAreaId: areaId,
        schedule: SCHEDULE,
        womenOnly: false,
      });
      ok(wanted, "the rider looking for a commute");

      // --- 1. The server finds the match -------------------------------------
      const matches = await api("GET", "/matches", rider.access);
      ok(matches, "listing matches");
      const match = (
        matches.json().data as Array<{
          user: { id: string };
          matchingDays: string[];
          rideId?: string;
        }>
      ).find((row) => row.user.id === driver.id);

      expect(match, "the rider should be matched with the driver").toBeDefined();
      // Same institution, same campus, compatible days and times — two of them.
      expect([...match!.matchingDays].sort()).toEqual(["Mon", "Wed"]);

      // --- Rides exist to ask about ------------------------------------------
      // The scheduler generates the week's instances. Nothing is bookable until
      // it has run, which is the engine the whole product depends on.
      await runScheduler();

      // Re-read the match: it now carries the specific ride to ask about,
      // which is how the app gets there rather than through a generic search.
      const withRide = (
        await api("GET", "/matches", rider.access)
      ).json().data as Array<{ user: { id: string }; rideId?: string }>;

      const rideId = withRide.find((row) => row.user.id === driver.id)?.rideId;
      expect(rideId, "the match should offer a specific ride to ask about").toBeDefined();

      // Which weekday that ride falls on is NOT fixed: the match offers the
      // next bookable instance, so on a Monday afternoon it is Wednesday and
      // on a Friday it is Monday. An earlier version of this test assumed
      // Monday and passed only on the days when that happened to be true.
      const booked = await RideInstanceModel.findById(rideId).lean();
      const bookedDay = booked!.day;
      const otherDay = bookedDay === "Mon" ? "Wed" : "Mon";

      // --- 2. The rider asks for a seat --------------------------------------
      const asked = await api("POST", `/rides/${rideId}/request`, rider.access, { seats: 1 });
      ok(asked, "asking for a seat");
      const requestId = asked.json().data.id as string;

      // The driver's phone learns about it on its own.
      await driverPhone.expect("seatRequest.created", "the driver is told about the request");
      await driverPhone.expect("notification.created", "the driver's badge moves");

      // And the request is actually in their list, without a refetch prompted
      // by anything other than the event.
      const incoming = await api("GET", "/requests/incoming", driver.access);
      expect(
        (incoming.json().data as Array<{ id: string }>).some((row) => row.id === requestId),
      ).toBe(true);

      // --- 3. The driver accepts ---------------------------------------------
      const accepted = await api("POST", `/requests/${requestId}/respond`, driver.access, {
        action: "accept",
      });
      ok(accepted, "accepting the request");

      // The rider's phone learns, without asking.
      await riderPhone.expect("seatRequest.accepted", "the rider is told they have a seat");

      // --- 4. The ride is confirmed for both ---------------------------------
      const seat = await AttendanceModel.findOne({
        rideInstanceId: rideId,
        userId: rider.id,
        role: "passenger",
      });
      expect(seat!.status).toBe("confirmed");

      // A seat was actually taken, atomically, rather than merely recorded.
      const afterAccept = await RideInstanceModel.findById(rideId);
      expect(afterAccept!.seatsTaken).toBe(1);

      // Contact details become available only now — the privacy rule the whole
      // product turns on. It is served on the match rather than on the ride or
      // on PublicUser, because a number does not belong in the shape everybody
      // is exposed as everywhere.
      const afterAcceptance = (
        await api("GET", "/matches", rider.access)
      ).json().data as Array<{ user: { id: string }; contactPhone?: string }>;

      const driverMatch = afterAcceptance.find((row) => row.user.id === driver.id);
      expect(
        driverMatch?.contactPhone,
        "the phone number should be released once a seat is accepted",
      ).toBeTruthy();

      // --- 5. The driver cannot make the day the rider booked ----------------
      const unavailable = await api(
        "POST",
        `/commutes/${driverCommuteId}/unavailable`,
        driver.access,
        { days: [bookedDay] },
      );
      ok(unavailable, "declaring that day unavailable");

      // The passenger finds out immediately rather than at the kerb.
      await riderPhone.expect("driverUnavailable", "the rider is told the driver dropped out");
      await riderPhone.expect("notification.created", "and gets a notification about it");

      const stranded = await RideInstanceModel.findById(rideId);
      expect(stranded!.status).toBe("noDriver");

      // Pending, not cancelled: they still want the ride, they just need
      // somebody to drive it.
      const pendingSeat = await AttendanceModel.findOne({
        rideInstanceId: rideId,
        userId: rider.id,
        role: "passenger",
      });
      expect(pendingSeat!.status).toBe("pending");

      // --- 6. Cover exists, and the rider chooses it -------------------------
      const cover = await makeUser(`e2e-cover-${stamp}@szabist.edu.pk`, "Hamza Siddiqui");
      const coverVehicle = await api("PUT", "/vehicles", cover.access, {
        type: "car",
        model: "Suzuki Cultus",
        plate: "AXB-704",
        colour: "Silver",
      });
      await api("POST", "/commutes", cover.access, {
        intent: "offer",
        direction: "both",
        campusId,
        originAreaId: areaId,
        schedule: [{ day: bookedDay, arriveBy: "08:00", leaveCampusAt: "17:00" }],
        vehicleId: coverVehicle.json().data.id,
        seatsOffered: 2,
        contribution: 300,
        womenOnly: false,
      });
      await runScheduler();

      const replacements = await api(
        "GET",
        `/commutes/${driverCommuteId}/replacements?day=${bookedDay}`,
        rider.access,
      );
      ok(replacements, "listing replacements");
      const option = (
        replacements.json().data as Array<{ id: string; driver: { id: string } }>
      ).find((row) => row.driver.id === cover.id);
      expect(option, "cover for that day should be offered").toBeDefined();

      // The passenger chooses. Nobody was moved for them — the product rule is
      // that a replacement is requested, never assigned.
      const coverPhone = listen("/events", cover.access);
      await coverPhone.ready;

      const askedCover = await api("POST", `/rides/${option!.id}/request`, rider.access, {
        seats: 1,
      });
      ok(askedCover, "asking the replacement driver");

      await coverPhone.expect("seatRequest.created", "the replacement driver is asked");

      const coverAccepted = await api(
        "POST",
        `/requests/${askedCover.json().data.id}/respond`,
        cover.access,
        { action: "accept" },
      );
      ok(coverAccepted, "the replacement accepting");

      await riderPhone.expect("seatRequest.accepted", "the rider has cover");

      // --- The ride the rider now has ----------------------------------------
      const newSeat = await AttendanceModel.findOne({
        rideInstanceId: option!.id,
        userId: rider.id,
        role: "passenger",
      });
      expect(newSeat!.status).toBe("confirmed");

      // The commute's other day is untouched: declaring one day unavailable
      // means the next occurrence of that day, not that day forever, and
      // certainly not the rest of the week.
      const untouched = await RideInstanceModel.findOne({
        commuteId: driverCommuteId,
        day: otherDay,
      });
      expect(untouched!.status).toBe("scheduled");

      driverPhone.close();
      riderPhone.close();
      coverPhone.close();
    },
    120_000,
  );
});
