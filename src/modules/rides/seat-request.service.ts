import mongoose, { Types } from "mongoose";
import { logger } from "../../utils/logger.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from "../../utils/errors.js";
import {
  AreaModel,
  AttendanceModel,
  BlockModel,
  CampusModel,
  CommuteModel,
  RideInstanceModel,
  SeatRequestModel,
  UserModel,
} from "../../db/models/index.js";
import { toPublicUser } from "../users/user.mapper.js";
import { notifyQuietly } from "../notifications/notification.service.js";
import { publishAll } from "../realtime/hub.js";
import type {
  CommuteDirection,
  DaySchedule,
  SeatRequest,
  Weekday,
} from "../../contract/types.js";

/**
 * Seat requests.
 *
 * Two directions that are never merged: `incoming` is people asking for seats
 * you offer — a to-do list with Accept and Decline on it — and `sent` is what
 * you have asked of others, which is a waiting list. Collapsing them into one
 * feed makes both useless.
 *
 * The hard part is acceptance. Several requests can arrive for the last seat
 * at the same moment, and read-then-write would let every one of them through.
 */

/** First name only, matching how the product addresses people everywhere. */
function firstNameOf(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : "Someone";
}

type RequestRow = {
  _id: Types.ObjectId;
  rideInstanceId: Types.ObjectId;
  requesterId: Types.ObjectId;
  driverId: Types.ObjectId;
  seats: number;
  status: string;
};

/**
 * Both parties' constraints, checked before a request can exist.
 *
 * Institution and campus come from the accounts involved, never the request.
 */
async function assertCanRequest(
  requesterId: string,
  instance: { _id: Types.ObjectId; driverId: Types.ObjectId; commuteId: Types.ObjectId; date: Date; status: string },
): Promise<void> {
  if (instance.driverId.equals(new Types.ObjectId(requesterId))) {
    throw new UnprocessableError("That is your own ride.");
  }

  if (instance.status !== "scheduled") {
    throw new UnprocessableError("That ride is no longer running.");
  }

  if (instance.date.getTime() < Date.now()) {
    throw new UnprocessableError("That ride has already happened.");
  }

  const [requester, driver] = await Promise.all([
    UserModel.findById(requesterId).lean(),
    UserModel.findById(instance.driverId).lean(),
  ]);

  if (!requester || !driver) throw new NotFoundError("That ride was not found.");

  // Hard constraints, both read from accounts. A ride id obtained from
  // anywhere else must not open a seat in another community.
  if (
    !requester.institutionId.equals(driver.institutionId) ||
    !requester.campusId.equals(driver.campusId)
  ) {
    throw new NotFoundError("That ride was not found.");
  }

  // Both directions. If either has blocked the other, the ride simply does
  // not exist as far as this request is concerned — a distinct error would
  // tell the blocked person they have been blocked.
  const blocked = await BlockModel.countDocuments({
    $or: [
      { blockerId: requesterId, blockedId: instance.driverId },
      { blockerId: instance.driverId, blockedId: requesterId },
    ],
  });
  if (blocked > 0) throw new NotFoundError("That ride was not found.");
}

/**
 * Asks for a seat.
 *
 * Creates a pending row and nothing else — no seat is consumed until the
 * driver accepts. Seats are checked here only so somebody is not invited to
 * queue for a ride that is visibly full.
 */
export async function requestSeat(
  requesterId: string,
  rideId: string,
  seats: number,
): Promise<SeatRequest> {
  const instance = await RideInstanceModel.findById(rideId).lean();
  if (!instance) throw new NotFoundError("That ride was not found.");

  await assertCanRequest(requesterId, instance);

  if (instance.seatsTaken + seats > instance.seatsOffered) {
    throw new BusinessRuleError("There are not that many seats left.");
  }

  const existing = await SeatRequestModel.findOne({
    rideInstanceId: instance._id,
    requesterId,
  }).lean();

  if (existing) {
    // Re-asking after a decline would let somebody pester a driver who has
    // already said no, and re-asking while pending would show the driver the
    // same person twice.
    if (existing.status === "pending") {
      throw new ConflictError("You have already asked for a seat on this ride.");
    }
    if (existing.status === "accepted") {
      throw new ConflictError("You already have a seat on this ride.");
    }
    throw new ConflictError("You have already asked about this ride.");
  }

  try {
    const created = await SeatRequestModel.create({
      rideInstanceId: instance._id,
      requesterId,
      driverId: instance.driverId,
      seats,
      status: "pending",
    });

    logger.info(
      { requesterId, rideId, seats },
      "seat requested",
    );

    // The driver is the one who has to act, so they are the one told. Not
    // awaited for delivery — `notify` writes the row and dispatches the push
    // afterwards, so a slow push provider cannot make asking for a seat fail.
    const asker = await UserModel.findById(requesterId).select("name").lean();
    await notifyQuietly({
      userId: instance.driverId,
      kind: "seatRequest",
      title: "Someone asked for a seat",
      body: `${firstNameOf(asker?.name)} would like a seat on your commute.`,
      payload: { requestId: created._id.toString() },
    });

    // The driver's Requests screen, if it is open, gains a row without being
    // touched. Published to both sides: the asker's own other devices need to
    // stop offering a button they have already used.
    publishAll(
      [
        { kind: "user", userId: instance.driverId.toString() },
        { kind: "user", userId: String(requesterId) },
      ],
      {
        type: "seatRequest.created",
        requestId: created._id.toString(),
        rideId: instance._id.toString(),
      },
    );

    const [mapped] = await toSeatRequests([created.toObject() as RequestRow], "sent");
    if (!mapped) throw new NotFoundError("That ride was not found.");
    return mapped;
  } catch (error) {
    // The unique {rideInstanceId, requesterId} index, under a double tap or a
    // retry on a flaky connection. The row exists either way.
    if ((error as { code?: number }).code === 11000) {
      throw new ConflictError("You have already asked for a seat on this ride.");
    }
    throw error;
  }
}

/**
 * Accepts or declines.
 *
 * Only the driver, and only from `pending`. A declined request must never
 * become accepted by a replayed call, and an accepted one must not be
 * declined into releasing a seat somebody is relying on.
 */
export async function respondToRequest(
  driverId: string,
  requestId: string,
  action: "accept" | "decline",
): Promise<SeatRequest> {
  // Scoped to the driver in the query itself, so another person's request
  // cannot match at all.
  const request = await SeatRequestModel.findOne({
    _id: requestId,
    driverId,
  }).lean();

  if (!request) throw new NotFoundError("That request was not found.");

  if (request.status !== "pending") {
    throw new ConflictError("That request has already been answered.");
  }

  if (action === "decline") {
    const declined = await SeatRequestModel.findOneAndUpdate(
      // Guarded on `pending`, so two taps cannot both succeed.
      { _id: request._id, status: "pending" },
      { $set: { status: "declined", respondedAt: new Date() } },
      { new: true },
    ).lean();

    if (!declined) throw new ConflictError("That request has already been answered.");

    logger.info({ driverId, requestId }, "seat request declined");

    // Told plainly and without a reason. The driver does not owe one, and
    // inventing one would be worse than the silence.
    await notifyQuietly({
      userId: request.requesterId,
      kind: "requestDeclined",
      title: "Your seat request was declined",
      body: "That ride is not available for you. There may be others.",
      payload: { requestId: request._id.toString() },
    });

    publishAll(
      [
        { kind: "user", userId: request.requesterId.toString() },
        { kind: "user", userId: driverId },
      ],
      {
        type: "seatRequest.declined",
        requestId: request._id.toString(),
        rideId: request.rideInstanceId.toString(),
      },
    );

    const [mapped] = await toSeatRequests([declined as RequestRow], "incoming");
    return mapped!;
  }

  return acceptRequest(driverId, request as RequestRow);
}

/**
 * Takes a seat, atomically.
 *
 * The invariant is that `seatsTaken` never exceeds `seatsOffered`, no matter
 * how many acceptances land at once. Read-then-write cannot provide that:
 * every concurrent caller reads the same free seat and every one writes.
 *
 * So capacity is claimed by a single guarded update. The `$expr` is evaluated
 * by the database against the document it is about to modify, which makes the
 * check and the increment one operation with nothing in between. A caller that
 * loses the race gets no document back and is told the seat has gone.
 *
 * The transaction is for the other two writes — the status change and the
 * attendance row — so a claimed seat can never be left without the request and
 * attendance that justify it.
 */
async function acceptRequest(
  driverId: string,
  request: RequestRow,
): Promise<SeatRequest> {
  const session = await mongoose.startSession();

  try {
    let accepted: RequestRow | null = null;

    await session.withTransaction(async () => {
      const claimed = await RideInstanceModel.findOneAndUpdate(
        {
          _id: request.rideInstanceId,
          status: "scheduled",
          // The whole guarantee, in one place: only matches while the seats
          // being taken still fit.
          $expr: {
            $lte: [
              { $add: ["$seatsTaken", request.seats] },
              "$seatsOffered",
            ],
          },
        },
        { $inc: { seatsTaken: request.seats } },
        { new: true, session },
      );

      if (!claimed) {
        // Either the ride filled up or it stopped running. The request stays
        // pending rather than being auto-declined: a seat may free up, and
        // silently refusing on the driver's behalf is not ours to do.
        throw new BusinessRuleError(
          "The last seat has gone. Nothing was changed.",
        );
      }

      const updated = await SeatRequestModel.findOneAndUpdate(
        { _id: request._id, status: "pending" },
        { $set: { status: "accepted", respondedAt: new Date() } },
        { new: true, session },
      ).lean();

      if (!updated) {
        // Somebody answered it between the read and here. Aborting returns
        // the seat, because the transaction never commits.
        throw new ConflictError("That request has already been answered.");
      }

      await AttendanceModel.updateOne(
        { rideInstanceId: request.rideInstanceId, userId: request.requesterId },
        {
          $set: { role: "passenger", status: "confirmed" },
          $setOnInsert: {
            rideInstanceId: request.rideInstanceId,
            userId: request.requesterId,
          },
        },
        { upsert: true, session },
      );

      accepted = updated as RequestRow;
    });

    logger.info(
      { driverId, requestId: request._id.toString(), seats: request.seats },
      "seat request accepted",
    );

    // Sent after the transaction has committed, never inside it: a push
    // dispatched from within a transaction that then aborts would tell
    // somebody they have a seat they do not have.
    const driver = await UserModel.findById(driverId).select("name").lean();
    await notifyQuietly({
      userId: request.requesterId,
      kind: "requestAccepted",
      title: "You have a seat",
      body: `${firstNameOf(driver?.name)} accepted your request. You can contact them now.`,
      payload: { requestId: request._id.toString() },
    });

    // Both sides, and the ride itself. The passenger's screen moves to
    // accepted and reveals the contact details it is now allowed to show; the
    // driver's list loses the pending row; anybody looking at this ride sees
    // the seat count drop.
    publishAll(
      [
        { kind: "user", userId: request.requesterId.toString() },
        { kind: "user", userId: driverId },
      ],
      {
        type: "seatRequest.accepted",
        requestId: request._id.toString(),
        rideId: request.rideInstanceId.toString(),
      },
    );

    const [mapped] = await toSeatRequests([accepted!], "incoming");
    return mapped!;
  } finally {
    await session.endSession();
  }
}

/**
 * Releases seats held by an accepted request.
 *
 * Used when a ride stops running. Floors at zero rather than trusting the
 * counter: a negative seat count would make a full ride look bookable.
 */
export async function releaseSeats(
  rideInstanceId: Types.ObjectId,
  seats: number,
): Promise<void> {
  await RideInstanceModel.updateOne(
    { _id: rideInstanceId, seatsTaken: { $gte: seats } },
    { $inc: { seatsTaken: -seats } },
  );
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Shapes rows for the client.
 *
 * `user` and `originArea` describe the OTHER party — for a driver that is who
 * is asking and where they would be picked up; for a requester it is whose
 * ride it is and where it starts. The schedule, direction and contribution
 * describe the arrangement itself.
 */
async function toSeatRequests(
  rows: RequestRow[],
  direction: "incoming" | "sent",
): Promise<SeatRequest[]> {
  if (rows.length === 0) return [];

  const otherIds = rows.map((row) =>
    direction === "incoming" ? row.requesterId : row.driverId,
  );

  const [others, instances] = await Promise.all([
    UserModel.find({ _id: { $in: otherIds } }).lean(),
    RideInstanceModel.find({ _id: { $in: rows.map((r) => r.rideInstanceId) } })
      .select("commuteId")
      .lean(),
  ]);

  const commutes = await CommuteModel.find({
    _id: { $in: instances.map((i) => i.commuteId) },
  })
    .select("schedule direction contribution campusId originAreaId ownerId")
    .lean();

  const [areas, campuses] = await Promise.all([
    AreaModel.find({
      _id: {
        $in: [
          ...commutes.map((c) => c.originAreaId),
          ...others.map((o) => o.areaId),
        ],
      },
    })
      .select("name")
      .lean(),
    CampusModel.find({ _id: { $in: commutes.map((c) => c.campusId) } })
      .select("name")
      .lean(),
  ]);

  const otherById = new Map(others.map((o) => [o._id.toString(), o]));
  const instanceById = new Map(instances.map((i) => [i._id.toString(), i]));
  const commuteById = new Map(commutes.map((c) => [c._id.toString(), c]));
  const areaById = new Map(areas.map((a) => [a._id.toString(), a]));
  const campusById = new Map(campuses.map((c) => [c._id.toString(), c]));

  const results: SeatRequest[] = [];

  for (const row of rows) {
    const otherId =
      direction === "incoming" ? row.requesterId : row.driverId;
    const other = otherById.get(otherId.toString());
    const instance = instanceById.get(row.rideInstanceId.toString());
    const commute = instance
      ? commuteById.get(instance.commuteId.toString())
      : undefined;

    if (!other || !commute) continue;

    // The other party's area: for a driver, where the passenger needs picking
    // up; for a passenger, where the ride starts.
    const areaId =
      direction === "incoming" ? other.areaId : commute.originAreaId;

    results.push({
      id: row._id.toString(),
      user: toPublicUser(other),
      originArea: areaById.get(areaId.toString())?.name ?? "",
      destinationCampus: campusById.get(commute.campusId.toString())?.name ?? "",
      schedule: commute.schedule.map((entry) => ({
        day: entry.day as Weekday,
        ...(entry.arriveBy ? { arriveBy: entry.arriveBy } : {}),
        ...(entry.leaveCampusAt ? { leaveCampusAt: entry.leaveCampusAt } : {}),
      })) as DaySchedule[],
      direction: commute.direction as CommuteDirection,
      seats: row.seats,
      contribution: commute.contribution ?? 0,
      status: row.status as SeatRequest["status"],
    });
  }

  return results;
}

/** People asking for seats you offer. A to-do list. */
export async function incomingRequests(driverId: string): Promise<SeatRequest[]> {
  const rows = await SeatRequestModel.find({
    driverId,
    // Pending first and foremost; answered ones stay visible briefly so the
    // list does not appear to swallow the thing just acted on.
    status: { $in: ["pending", "accepted"] },
  })
    .sort({ status: 1, createdAt: -1 })
    .limit(100)
    .lean();

  return toSeatRequests(rows as RequestRow[], "incoming");
}

/** What you have asked of other people. A waiting list. */
export async function sentRequests(requesterId: string): Promise<SeatRequest[]> {
  const rows = await SeatRequestModel.find({
    requesterId,
    status: { $in: ["pending", "accepted", "declined"] },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return toSeatRequests(rows as RequestRow[], "sent");
}
