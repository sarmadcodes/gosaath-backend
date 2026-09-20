import { Types } from "mongoose";
import { minutesFromTime } from "../../utils/dates.js";
import { distanceKm } from "../../utils/geo.js";
import {
  AreaMatchModel,
  AreaModel,
  BlockModel,
  CampusModel,
  CommuteModel,
  PreferencesModel,
  RideInstanceModel,
  UserModel,
} from "../../db/models/index.js";
import { toPublicUser } from "../users/user.mapper.js";
import { proximityBetween } from "../location/location.service.js";
import type {
  CommuteMatch,
  MatchSummary,
  Weekday,
} from "../../contract/types.js";

/**
 * Matching.
 *
 * The hottest path in the product, and the one with the strictest rules:
 *
 *   - institution and campus are CONSTRAINTS, not filters. They are read from
 *     the caller's own commute and can never be supplied by a request.
 *   - blocks apply in BOTH directions. A blocked person must not see the
 *     blocker either, or the silence gives the block away.
 *   - matching is per day. Two people overlapping on Monday and Wednesday but
 *     not Tuesday is the normal case, not an edge case.
 *   - the five-way state is computed here. The client cannot tell "nobody on
 *     your days" from "nobody here at all" by looking at an empty array.
 */

/** How far apart two campus times can be and still count as the same run. */
const DEFAULT_TOLERANCE_MINUTES = 30;

const TOLERANCE_BY_WINDOW: Record<string, number> = {
  "15 minutes": 15,
  "30 minutes": 30,
  "45 minutes": 45,
  "1 hour": 60,
};

type ScheduleEntry = {
  day: string;
  arriveBy?: string | null;
  leaveCampusAt?: string | null;
};

/**
 * Everyone the caller must not see, in either direction.
 *
 * Both queries are necessary. Filtering only on who the caller blocked leaves
 * the blocked person still seeing them, which is how somebody works out they
 * have been blocked.
 */
async function hiddenUserIds(userId: string): Promise<Types.ObjectId[]> {
  const [blockedByMe, blockedMe] = await Promise.all([
    BlockModel.find({ blockerId: userId }).select("blockedId").lean(),
    BlockModel.find({ blockedId: userId }).select("blockerId").lean(),
  ]);

  return [
    ...blockedByMe.map((row) => row.blockedId),
    ...blockedMe.map((row) => row.blockerId),
  ];
}

/**
 * Which days two schedules genuinely share.
 *
 * Compared on `arriveBy` — the campus time both sides actually stated. A day
 * where only one of them travels in is not a match: there is nothing to share.
 */
export function overlappingDays(
  mine: ScheduleEntry[],
  theirs: ScheduleEntry[],
  toleranceMinutes = DEFAULT_TOLERANCE_MINUTES,
): { sharedDays: Weekday[]; matchingDays: Weekday[] } {
  const theirsByDay = new Map(theirs.map((entry) => [entry.day, entry]));
  const sharedDays: Weekday[] = [];
  const matchingDays: Weekday[] = [];

  for (const entry of mine) {
    const other = theirsByDay.get(entry.day);
    if (!other) continue;

    // Both travel that day, whatever the times. Tracked separately so the
    // summary can say "same days, different times" rather than collapsing it
    // into "no matches".
    sharedDays.push(entry.day as Weekday);

    const a = entry.arriveBy ? minutesFromTime(entry.arriveBy) : null;
    const b = other.arriveBy ? minutesFromTime(other.arriveBy) : null;
    if (a === null || b === null) continue;

    if (Math.abs(a - b) <= toleranceMinutes) {
      matchingDays.push(entry.day as Weekday);
    }
  }

  return { sharedDays, matchingDays };
}

async function toleranceFor(userId: string): Promise<number> {
  const preferences = await PreferencesModel.findOne({ userId }).lean();
  const window = preferences?.timeWindow;
  return (window && TOLERANCE_BY_WINDOW[window]) || DEFAULT_TOLERANCE_MINUTES;
}

type Candidate = {
  commute: {
    _id: Types.ObjectId;
    ownerId: Types.ObjectId;
    originAreaId: Types.ObjectId;
    schedule: ScheduleEntry[];
    intent: string;
    seatsOffered?: number | null;
    contribution?: number | null;
    womenOnly: boolean;
  };
  sharedDays: Weekday[];
  matchingDays: Weekday[];
};

/**
 * Finds candidates and classifies them.
 *
 * Institution, campus and status are filtered in MongoDB against the
 * `{institutionId, campusId, status}` index; the per-day time comparison then
 * runs over what survives. Pulling every active commute into Node and
 * filtering there would not survive a campus of any size.
 */
type MyCommute = {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  institutionId: Types.ObjectId;
  campusId: Types.ObjectId;
  originAreaId: Types.ObjectId;
  schedule: ScheduleEntry[];
  womenOnly: boolean;
};

async function findCandidates(userId: string): Promise<{
  mine: MyCommute | null;
  candidates: Candidate[];
  othersAtCampus: number;
}> {
  const mine = (await CommuteModel.findOne({
    ownerId: userId,
    status: "active",
  }).lean()) as MyCommute | null;

  if (!mine) return { mine: null, candidates: [], othersAtCampus: 0 };

  const hidden = await hiddenUserIds(userId);
  const tolerance = await toleranceFor(userId);
  const myDays = mine.schedule.map((entry) => entry.day);

  // Institution and campus come from the caller's own commute. There is no
  // parameter for them, so there is nothing for a request to tamper with.
  const base = {
    institutionId: mine.institutionId,
    campusId: mine.campusId,
    status: "active" as const,
    ownerId: { $nin: [mine.ownerId, ...hidden] },
  };

  // Counted separately so "nobody here yet" and "nobody on your days" stay
  // distinguishable — they call for completely different copy.
  const othersAtCampus = await CommuteModel.countDocuments(base);

  if (othersAtCampus === 0) {
    return { mine, candidates: [], othersAtCampus: 0 };
  }

  const rows = await CommuteModel.find({
    ...base,
    // Narrows in the database rather than in Node: only people who travel on
    // at least one of the caller's days can possibly match.
    "schedule.day": { $in: myDays },
  })
    .select("ownerId originAreaId schedule intent seatsOffered contribution womenOnly")
    .limit(200)
    .lean();

  const candidates: Candidate[] = [];

  for (const row of rows) {
    /**
     * womenOnly, as far as it can currently be honoured.
     *
     * INCOMPLETE, AND KNOWN TO BE. The product has a women-only flag on the
     * commute but the system stores no gender for anybody — not on User, not
     * in the contract, nowhere. So this cannot do what the feature name
     * promises. What it does instead is pair the flag symmetrically: a
     * women-only commute only ever meets another women-only commute.
     *
     * That is the safest behaviour available without gender, and it is
     * deliberately conservative — it under-matches rather than over-matches.
     * It is still not a guarantee, and it must not be presented to users as
     * one until there is something real to check against.
     *
     * Resolving this is a product decision, not a technical one: collecting
     * gender changes what this app holds about people, which is a choice the
     * owner has to make deliberately.
     */
    if (mine.womenOnly !== row.womenOnly) continue;

    const { sharedDays, matchingDays } = overlappingDays(
      mine.schedule,
      row.schedule,
      tolerance,
    );
    if (sharedDays.length === 0) continue;

    candidates.push({ commute: row as Candidate["commute"], sharedDays, matchingDays });
  }

  return { mine, candidates, othersAtCampus };
}

/**
 * The Home card's state.
 *
 * Five-way rather than a count, because the client cannot infer the difference
 * from an empty array: "nobody travels on your days" and "nobody is here yet"
 * are both zero matches and need entirely different things said about them.
 */
export async function matchSummary(userId: string): Promise<MatchSummary> {
  const { mine, candidates, othersAtCampus } = await findCandidates(userId);

  const campusName = mine
    ? ((await CampusModel.findById(mine.campusId).select("name").lean())?.name ?? "")
    : "";

  if (!mine) return { state: "noCommute", count: 0, campusName };
  if (othersAtCampus === 0) return { state: "none", count: 0, campusName };

  const withSharedDays = candidates.filter((c) => c.sharedDays.length > 0);
  if (withSharedDays.length === 0) {
    return { state: "noDayMatch", count: 0, campusName };
  }

  const matched = candidates.filter((c) => c.matchingDays.length > 0);
  if (matched.length === 0) {
    // Days line up, times do not. Worth saying, because the fix is a small
    // change to their own times rather than waiting for more people.
    return { state: "noTimeMatch", count: 0, campusName };
  }

  return { state: "matches", count: matched.length, campusName };
}

/**
 * The match list.
 *
 * `matchingDays` is computed here and rendered by the client. The UI must not
 * derive it: it has neither the other person's schedule nor the tolerance, and
 * duplicating the rule would guarantee the two drift.
 */
export async function listMatches(userId: string): Promise<CommuteMatch[]> {
  const { mine, candidates } = await findCandidates(userId);
  if (!mine) return [];

  const matched = candidates.filter((c) => c.matchingDays.length > 0);
  if (matched.length === 0) return [];

  const ownerIds = matched.map((c) => c.commute.ownerId);

  const [users, decisions, areas] = await Promise.all([
    UserModel.find({ _id: { $in: ownerIds } }).lean(),
    AreaMatchModel.find({ userId, matchedUserId: { $in: ownerIds } }).lean(),
    AreaModel.find({
      _id: { $in: [mine.originAreaId, ...matched.map((c) => c.commute.originAreaId)] },
    }).lean(),
  ]);

  // Rejected matches stay rejected. Somebody the user dismissed reappearing on
  // the next refresh is the fastest way to make the list feel broken.
  const rejected = new Set(
    decisions.filter((d) => d.status === "rejected").map((d) => d.matchedUserId.toString()),
  );

  const decisionByUser = new Map(
    decisions.map((d) => [d.matchedUserId.toString(), d.status]),
  );
  const campusName =
    (await CampusModel.findById(mine.campusId).select("name").lean())?.name ?? "";
  const userById = new Map(users.map((user) => [user._id.toString(), user]));
  const areaById = new Map(areas.map((area) => [area._id.toString(), area]));
  const myArea = areaById.get(mine.originAreaId.toString());

  // Which of these people are actually offering a seat right now. Without it
  // the match screen can only offer a generic search, which is a dead end from
  // a screen about one specific person.
  const openRides = await RideInstanceModel.find({
    driverId: { $in: ownerIds },
    date: { $gte: new Date() },
    status: "scheduled",
    $expr: { $lt: ["$seatsTaken", "$seatsOffered"] },
  })
    .sort({ date: 1 })
    .lean();

  const rideByDriver = new Map<string, (typeof openRides)[number]>();
  const takenByDriver = new Map<string, number>();
  for (const ride of openRides) {
    const key = ride.driverId.toString();
    if (!rideByDriver.has(key)) {
      rideByDriver.set(key, ride);
      takenByDriver.set(key, ride.seatsTaken);
    }
  }

  const results: CommuteMatch[] = [];

  for (const candidate of matched) {
    const ownerId = candidate.commute.ownerId.toString();
    if (rejected.has(ownerId)) continue;

    const user = userById.get(ownerId);
    if (!user) continue;

    const theirArea = areaById.get(candidate.commute.originAreaId.toString());
    const ride = rideByDriver.get(ownerId);
    const offering =
      candidate.commute.intent === "offer" || candidate.commute.intent === "both";

    const proximity =
      myArea?.centroid && theirArea?.centroid
        ? proximityBetween(myArea, theirArea)
        : undefined;

    results.push({
      id: candidate.commute._id.toString(),
      user: toPublicUser(user),
      area: theirArea?.name ?? "",
      campusName,
      // Their own per-day times, so the viewer can see which days line up
      // rather than being told a number and asked to trust it.
      schedule: candidate.commute.schedule.map((entry) => ({
        day: entry.day as Weekday,
        ...(entry.arriveBy ? { arriveBy: entry.arriveBy } : {}),
        ...(entry.leaveCampusAt ? { leaveCampusAt: entry.leaveCampusAt } : {}),
      })),
      matchingDays: candidate.matchingDays,
      intent: candidate.commute.intent as CommuteMatch["intent"],
      ...(offering && candidate.commute.seatsOffered
        ? { seatsAvailable: Math.max(0, candidate.commute.seatsOffered - (takenByDriver.get(ownerId) ?? 0)) }
        : {}),
      ...(candidate.commute.contribution != null
        ? { contribution: candidate.commute.contribution }
        : {}),
      ...(ride ? { rideId: ride._id.toString() } : {}),
      ...(takenByDriver.get(ownerId) ? { seatsTaken: takenByDriver.get(ownerId) } : {}),
      // Served only for people the caller is actually matched with, and
      // deliberately not part of PublicUser.
      contactPhone: user.phone,
      areaMatch: (decisionByUser.get(ownerId) ?? "pending") as CommuteMatch["areaMatch"],
      ...(proximity ? { proximity } : {}),
    });
  }

  return results;
}

/**
 * Records whether the viewer accepts the other person's area.
 *
 * Server-side rather than on the device: a rejection must survive a reinstall
 * and apply on every device the person signs in on.
 */
export async function setAreaMatch(
  userId: string,
  matchId: string,
  status: "accepted" | "rejected",
): Promise<CommuteMatch | null> {
  const commute = await CommuteModel.findById(matchId).select("ownerId").lean();
  if (!commute) return null;

  await AreaMatchModel.findOneAndUpdate(
    { userId, matchedUserId: commute.ownerId },
    { $set: { status } },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const matches = await listMatches(userId);
  return matches.find((match) => match.id === matchId) ?? null;
}

/** Straight-line distance between two area centroids. Internal only. */
export function areaDistanceKm(
  a: { centroid?: { lat: number; lng: number } | null },
  b: { centroid?: { lat: number; lng: number } | null },
): number | null {
  if (!a.centroid || !b.centroid) return null;
  return distanceKm(a.centroid, b.centroid);
}
