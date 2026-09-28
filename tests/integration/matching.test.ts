import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaMatchModel,
  AreaModel,
  AttendanceModel,
  BlockModel,
  CampusModel,
  CommuteModel,
  InstitutionModel,
  RideInstanceModel,
  SessionModel,
  UserModel,
  VehicleModel,
} from "../../src/db/models/index.js";
import { overlappingDays } from "../../src/modules/matching/matching.service.js";

/**
 * Phase 5 gate.
 *
 * The rules that must never bend: institution and campus are constraints, not
 * filters; blocks apply in both directions; matchingDays is computed here; and
 * the summary distinguishes states an empty array cannot.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let gulshanId: string;
let cliftonId: string;
let maliId: string;

type Person = { access: string; id: string; commuteId?: string };
let alice: Person;
let bob: Person;

const api = (
  method: "GET" | "POST",
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

async function makeUser(email: string): Promise<Person> {
  await app.inject({
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
      areaId: gulshanId,
    },
  });
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
  return {
    access: refresh.json().data.accessToken as string,
    id: user!._id.toString(),
  };
}

async function giveCommute(
  person: Person,
  overrides: Record<string, unknown> = {},
) {
  const response = await api("POST", "/commutes", person.access, {
    intent: "find",
    campusId,
    originAreaId: gulshanId,
    schedule: [
      { day: "Mon", arriveBy: "08:00", leaveCampusAt: "17:00" },
      { day: "Wed", arriveBy: "08:00", leaveCampusAt: "17:00" },
      { day: "Fri", arriveBy: "08:00" },
    ],
    direction: "both",
    womenOnly: false,
    ...overrides,
  });
  person.commuteId = response.json().data?.id;
  return response;
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();

  institutionId = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  gulshanId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
  cliftonId = (await AreaModel.findOne({ name: "Clifton" }))!._id.toString();
  maliId = (await AreaModel.findOne({ name: "Malir" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await UserModel.deleteMany({ email: /@szabist\.edu\.pk$/ });
  await CommuteModel.deleteMany({});
  await RideInstanceModel.deleteMany({});
  await AttendanceModel.deleteMany({});
  await BlockModel.deleteMany({});
  await AreaMatchModel.deleteMany({});
  await VehicleModel.deleteMany({});
  await SessionModel.deleteMany({});

  alice = await makeUser("alice@szabist.edu.pk");
  bob = await makeUser("bob@szabist.edu.pk");
});

describe("overlappingDays", () => {
  it("returns only the days both sides actually travel", () => {
    const { matchingDays } = overlappingDays(
      [
        { day: "Mon", arriveBy: "08:00" },
        { day: "Tue", arriveBy: "08:00" },
        { day: "Wed", arriveBy: "08:00" },
      ],
      [
        { day: "Mon", arriveBy: "08:00" },
        { day: "Wed", arriveBy: "08:15" },
      ],
    );
    // Two of three is the normal case, not an edge case.
    expect(matchingDays).toEqual(["Mon", "Wed"]);
  });

  it("separates shared days from matching ones", () => {
    const result = overlappingDays(
      [{ day: "Mon", arriveBy: "08:00" }],
      [{ day: "Mon", arriveBy: "14:00" }],
    );
    // Same day, hours apart. Tracked separately so the summary can say
    // "same days, different times" rather than "no matches".
    expect(result.sharedDays).toEqual(["Mon"]);
    expect(result.matchingDays).toEqual([]);
  });

  it("honours the tolerance boundary exactly", () => {
    const at30 = overlappingDays(
      [{ day: "Mon", arriveBy: "08:00" }],
      [{ day: "Mon", arriveBy: "08:30" }],
      30,
    );
    const at31 = overlappingDays(
      [{ day: "Mon", arriveBy: "08:00" }],
      [{ day: "Mon", arriveBy: "08:31" }],
      30,
    );
    expect(at30.matchingDays).toEqual(["Mon"]);
    expect(at31.matchingDays).toEqual([]);
  });

  it("does not match a day where only one side stated a time", () => {
    const result = overlappingDays(
      [{ day: "Fri", arriveBy: "08:00" }],
      [{ day: "Fri", leaveCampusAt: "17:00" }],
    );
    // Nothing to compare: one travels in, the other only home.
    expect(result.sharedDays).toEqual(["Fri"]);
    expect(result.matchingDays).toEqual([]);
  });
});

describe("match summary states", () => {
  it("noCommute before one is set up", async () => {
    const response = await api("GET", "/matches/summary", alice.access);
    expect(response.json().data.state).toBe("noCommute");
  });

  it("none when nobody else is at the campus", async () => {
    await giveCommute(alice);
    const response = await api("GET", "/matches/summary", alice.access);
    // "You're early here" — a different problem from "nobody on your days",
    // and the client cannot tell them apart from a count of zero.
    expect(response.json().data.state).toBe("none");
  });

  it("noDayMatch when somebody is here but travels other days", async () => {
    await giveCommute(alice);
    await giveCommute(bob, {
      schedule: [{ day: "Tue", arriveBy: "08:00" }],
    });

    const response = await api("GET", "/matches/summary", alice.access);
    expect(response.json().data.state).toBe("noDayMatch");
  });

  it("noTimeMatch when days line up but times do not", async () => {
    await giveCommute(alice);
    await giveCommute(bob, {
      schedule: [{ day: "Mon", arriveBy: "14:00" }],
    });

    const response = await api("GET", "/matches/summary", alice.access);
    // Worth saying: the fix is a small change to their own times, not waiting
    // for more people to join.
    expect(response.json().data.state).toBe("noTimeMatch");
  });

  it("matches, with a count and the campus name", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    const summary = (await api("GET", "/matches/summary", alice.access)).json().data;
    expect(summary.state).toBe("matches");
    expect(summary.count).toBe(1);
    expect(summary.campusName).toBe("Clifton Campus");
  });
});

describe("hard constraints", () => {
  it("never matches across institutions, even with identical schedules", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    // Same campus id, same area, same times — only the institution differs.
    const other = await InstitutionModel.create({
      name: `Other ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#123456",
      active: true,
    });
    try {
      await CommuteModel.updateOne(
        { ownerId: bob.id },
        { $set: { institutionId: other._id } },
      );

      const summary = (await api("GET", "/matches/summary", alice.access)).json().data;
      // Institution is a constraint, not a preference. Identical everything
      // else must not be enough.
      expect(summary.state).toBe("none");
      expect((await api("GET", "/matches", alice.access)).json().data).toEqual([]);
    } finally {
      await other.deleteOne();
    }
  });

  it("never matches across campuses", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    const otherCampus = await CampusModel.create({
      institutionId,
      name: `Other Campus ${Date.now()}`,
    });
    try {
      await CommuteModel.updateOne(
        { ownerId: bob.id },
        { $set: { campusId: otherCampus._id } },
      );

      expect((await api("GET", "/matches", alice.access)).json().data).toEqual([]);
    } finally {
      await otherCampus.deleteOne();
    }
  });

  it("excludes a cancelled commute", async () => {
    await giveCommute(alice);
    await giveCommute(bob);
    await CommuteModel.updateOne({ ownerId: bob.id }, { $set: { status: "cancelled" } });

    expect((await api("GET", "/matches", alice.access)).json().data).toEqual([]);
  });
});

describe("blocking", () => {
  it("hides the blocked person from the blocker", async () => {
    await giveCommute(alice);
    await giveCommute(bob);
    await BlockModel.create({ blockerId: alice.id, blockedId: bob.id });

    expect((await api("GET", "/matches", alice.access)).json().data).toEqual([]);
  });

  it("ALSO hides the blocker from the blocked person", async () => {
    await giveCommute(alice);
    await giveCommute(bob);
    await BlockModel.create({ blockerId: alice.id, blockedId: bob.id });

    // One direction only would leave Bob still seeing Alice — and silence
    // from somebody who is plainly still there is how a block gives itself
    // away. Blocking has to be silent to be safe.
    expect((await api("GET", "/matches", bob.access)).json().data).toEqual([]);
  });

  it("hides blocked people from ride search too, both ways", async () => {
    await giveCommute(bob, {
      intent: "offer",
      vehicleId: (
        await VehicleModel.create({
          ownerId: bob.id,
          type: "car",
          model: "Corolla",
          plate: "BOB-1",
          colour: "White",
        })
      )._id.toString(),
      seatsOffered: 3,
      contribution: 300,
    });
    await giveCommute(alice);

    const beforeBlock = (await api("GET", "/rides/nearby", alice.access)).json().data;
    expect(beforeBlock.length).toBeGreaterThan(0);

    await BlockModel.create({ blockerId: bob.id, blockedId: alice.id });

    // Bob blocked Alice; Alice must stop seeing Bob's rides.
    expect((await api("GET", "/rides/nearby", alice.access)).json().data).toEqual([]);
  });
});

describe("match list", () => {
  it("computes matchingDays server-side and carries their schedule", async () => {
    await giveCommute(alice);
    await giveCommute(bob, {
      schedule: [
        { day: "Mon", arriveBy: "08:10" },
        { day: "Tue", arriveBy: "08:00" },
      ],
    });

    const matches = (await api("GET", "/matches", alice.access)).json().data;
    expect(matches).toHaveLength(1);
    // Rendered by the client, never derived there: it has neither the other
    // schedule nor the tolerance.
    expect(matches[0].matchingDays).toEqual(["Mon"]);
    expect(matches[0].schedule).toHaveLength(2);
    expect(matches[0].campusName).toBe("Clifton Campus");
  });

  it("exposes only a PublicUser, never a full account", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    const response = await api("GET", "/matches", alice.access);
    const raw = response.body;

    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("@szabist.edu.pk");
    // First name only. "bob Person" is the full name; only "bob" may appear.
    expect(response.json().data[0].user.firstName).toBe("bob");
    expect(response.json().data[0].user.name).toBeUndefined();
  });

  it("hides the contact number until a request has been accepted", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    // SYSTEM.md 4.5.3. Being matched is the system's guess that two
    // timetables overlap; neither person has agreed to anything yet.
    const match = (await api("GET", "/matches", alice.access)).json().data[0];
    expect(match.contactPhone).toBeUndefined();
    expect(match.user.contactPhone).toBeUndefined();
    expect((await api("GET", "/matches", alice.access)).body).not.toContain(
      "0300 1234567",
    );
  });

  it("gives the contact number once a seat request is accepted", async () => {
    await giveCommute(alice);
    await giveCommute(bob, {
      intent: "offer",
      seatsOffered: 2,
      contribution: 200,
      vehicleId: (
        await VehicleModel.create({
          ownerId: bob.id,
          type: "car",
          model: "Toyota Corolla",
          plate: "ABC-123",
          colour: "White",
        })
      )._id.toString(),
    });

    // Tomorrow onwards: today's instance may already have departed, and a
    // seat cannot be requested on a ride that has happened.
    const ride = await RideInstanceModel.findOne({
      driverId: bob.id,
      date: { $gt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    })
      .sort({ date: 1 })
      .lean();
    const created = await api("POST", `/rides/${ride!._id.toString()}/request`, alice.access, {
      seats: 1,
    });

    // Still nothing while it is only pending.
    const pending = (await api("GET", "/matches", alice.access)).json().data[0];
    expect(pending.contactPhone).toBeUndefined();

    await api("POST", `/requests/${created.json().data.id}/respond`, bob.access, {
      action: "accept",
    });

    // Both directions: the person who asked and the person who said yes each
    // need to be able to reach the other.
    const forRider = (await api("GET", "/matches", alice.access)).json().data[0];
    const forDriver = (await api("GET", "/matches", bob.access)).json().data[0];
    expect(forRider.contactPhone).toBe("0300 1234567");
    expect(forDriver.contactPhone).toBe("0300 1234567");
  });

  it("never returns a centroid or a raw distance", async () => {
    await giveCommute(alice);
    await giveCommute(bob, { originAreaId: cliftonId });

    const response = await api("GET", "/matches", alice.access);
    expect(response.body).not.toContain("centroid");
    // The phrase is what the UI renders. A figure implies a precision this
    // product does not have.
    const match = response.json().data[0];
    if (match?.proximity) {
      expect(typeof match.proximity.label).toBe("string");
    }
  });

  it("keeps a rejected area match rejected", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    const match = (await api("GET", "/matches", alice.access)).json().data[0];
    await api("POST", `/matches/${match.id}/area`, alice.access, {
      status: "rejected",
    });

    // Somebody the user dismissed reappearing on the next refresh is the
    // fastest way to make the list feel broken.
    expect((await api("GET", "/matches", alice.access)).json().data).toEqual([]);
  });

  it("records an accepted area match without hiding them", async () => {
    await giveCommute(alice);
    await giveCommute(bob);

    const match = (await api("GET", "/matches", alice.access)).json().data[0];
    const response = await api("POST", `/matches/${match.id}/area`, alice.access, {
      status: "accepted",
    });

    expect(response.json().data.areaMatch).toBe("accepted");
  });
});

describe("nearby radius", () => {
  async function bobOffersFrom(areaId: string) {
    const vehicle = await VehicleModel.create({
      ownerId: bob.id,
      type: "car",
      model: "Corolla",
      plate: "BOB-2",
      colour: "White",
    });
    await giveCommute(bob, {
      intent: "offer",
      originAreaId: areaId,
      vehicleId: vehicle._id.toString(),
      seatsOffered: 3,
      contribution: 300,
    });
  }

  it("includes a ride from the same area", async () => {
    await giveCommute(alice);
    await bobOffersFrom(gulshanId);

    const nearby = (await api("GET", "/rides/nearby", alice.access)).json().data;
    expect(nearby.length).toBeGreaterThan(0);
  });

  it("excludes a ride from across the city", async () => {
    await giveCommute(alice);
    // Gulshan to Malir is roughly eleven kilometres. If this ever passes,
    // "nearby" has quietly become "everyone".
    await bobOffersFrom(maliId);

    expect((await api("GET", "/rides/nearby", alice.access)).json().data).toEqual([]);
  });
});

describe("ride search constraints", () => {
  it("rejects a supplied institution that is not the caller's", async () => {
    await giveCommute(alice);
    const other = await InstitutionModel.create({
      name: `Sneaky ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#000000",
      active: true,
    });
    try {
      const response = await api(
        "GET",
        `/rides?institutionId=${other._id.toString()}`,
        alice.access,
      );
      // 403, not an empty list. Empty would teach an attacker the field is
      // respected but unlucky, and invite them to keep trying.
      expect(response.statusCode).toBe(403);
    } finally {
      await other.deleteOne();
    }
  });

  it("returns a listing shaped as the client expects", async () => {
    await giveCommute(alice);
    const vehicle = await VehicleModel.create({
      ownerId: bob.id,
      type: "car",
      model: "Toyota Corolla GLi",
      plate: "BOB-3",
      colour: "White",
    });
    await giveCommute(bob, {
      intent: "offer",
      vehicleId: vehicle._id.toString(),
      seatsOffered: 3,
      contribution: 300,
    });

    const listing = (await api("GET", "/rides/nearby", alice.access)).json().data[0];
    expect(listing.commuteId).toBeTruthy();
    expect(listing.vehicleType).toBe("car");
    expect(listing.destinationCampus).toBe("Clifton Campus");
    expect(listing.seatsAvailable).toBe(3);
    expect(listing.sameCampus).toBe(true);
    expect(Array.isArray(listing.schedule)).toBe(true);
  });
});

describe("query plans", () => {
  it("uses the index for the match query rather than scanning", async () => {
    await giveCommute(alice);

    const commute = await CommuteModel.findOne({ ownerId: alice.id }).lean();

    const plan = await CommuteModel.find({
      institutionId: commute!.institutionId,
      campusId: commute!.campusId,
      status: "active",
    }).explain("queryPlanner");

    const stage = JSON.stringify(
      (plan as { queryPlanner?: { winningPlan?: unknown } }).queryPlanner
        ?.winningPlan ?? {},
    );

    // The hot path. A COLLSCAN here is fine with three rows and fatal with
    // thirty thousand, and nothing in a passing test would otherwise say so.
    expect(stage).toContain("IXSCAN");
    expect(stage).not.toContain("COLLSCAN");
  });

  it("uses the index for the open-seat ride query", async () => {
    const plan = await RideInstanceModel.find({
      date: { $gte: new Date() },
      status: "scheduled",
    }).explain("queryPlanner");

    const stage = JSON.stringify(
      (plan as { queryPlanner?: { winningPlan?: unknown } }).queryPlanner
        ?.winningPlan ?? {},
    );
    expect(stage).toContain("IXSCAN");
  });
});
