import { randomInt } from "node:crypto";
import { Types } from "mongoose";
import { announceReportCreated } from "../realtime/announce.js";
import { publish } from "../realtime/hub.js";
import { logger } from "../../utils/logger.js";
import { NotFoundError, UnprocessableError } from "../../utils/errors.js";
import {
  AreaMatchModel,
  BlockModel,
  ReportModel,
  SeatRequestModel,
  SupportRequestModel,
  UserModel,
} from "../../db/models/index.js";
import { toPublicUser } from "../users/user.mapper.js";
import type { PublicUser } from "../../contract/types.js";

/**
 * Reports, blocks and support.
 *
 * Reports and support are separate on purpose: a report is about a person and
 * goes to moderation; support is about the product. Mixed together, a genuine
 * safety report waits behind "I forgot my password".
 */

export const REPORT_CATEGORIES = [
  "unsafe-driving",
  "behaviour",
  "harassment",
  "fake-profile",
  "route",
  "other",
] as const;

export const SUPPORT_CATEGORIES = [
  "account",
  "commute",
  "ride",
  "payment",
  "bug",
  "other",
] as const;

/**
 * Files a report.
 *
 * Returns nothing to the reporter, by design. No report id, no status to poll:
 * the outcome belongs to moderation, and handing the reporter a handle would
 * imply an entitlement to follow the case that the product does not offer.
 *
 * The reported person must share the reporter's institution — reports are
 * handled by that institution's admins, and a report across communities would
 * land in a queue nobody responsible can see.
 */
export async function fileReport(
  reporterId: string,
  input: { reportedUserId?: string | undefined; category: string; detail?: string | undefined },
): Promise<void> {
  const reporter = await UserModel.findById(reporterId).select("institutionId").lean();
  if (!reporter) throw new NotFoundError("Account not found.");

  if (input.reportedUserId) {
    if (input.reportedUserId === reporterId) {
      throw new UnprocessableError("You cannot report yourself.");
    }
    const reported = await UserModel.findOne({
      _id: input.reportedUserId,
      institutionId: reporter.institutionId,
    })
      .select("_id")
      .lean();
    // Same message whether the person does not exist or is elsewhere: the
    // form must not be a way to test which ids are real.
    if (!reported) throw new NotFoundError("That person was not found.");
  }

  await ReportModel.create({
    reporterId,
    reportedUserId: input.reportedUserId ?? null,
    institutionId: reporter.institutionId,
    category: input.category,
    detail: input.detail ?? undefined,
    status: "open",
  });

  // The detail is not logged. It is a person's account of something that
  // happened to them and belongs in the moderation queue, not the log stream.
  logger.info({ reporterId, category: input.category }, "report filed");

  // The moderation queue gains a row for every administrator of this
  // institution who has the console open. Only the count travels: who reported
  // whom, and why, is the most sensitive thing in this system, and an admin
  // event reaches every administrator rather than the one who opens the queue.
  await announceReportCreated(reporter.institutionId.toString());
}

/**
 * Blocks somebody. Silent, and idempotent.
 *
 * Blocking also withdraws anything pending between the two, in both
 * directions — otherwise a blocked person's earlier seat request would still
 * sit in the blocker's to-do list, and the blocker's own request would still
 * be waiting on somebody they never want to hear from.
 *
 * Accepted seats are left alone. Pulling somebody off a ride they are relying
 * on tomorrow morning, without warning, is a safety decision for a person to
 * make with context — not a side effect of a button.
 */
export async function block(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) {
    throw new UnprocessableError("You cannot block yourself.");
  }

  const target = await UserModel.findById(blockedId).select("_id").lean();
  if (!target) throw new NotFoundError("That person was not found.");

  await BlockModel.updateOne(
    { blockerId, blockedId },
    { $setOnInsert: { blockerId, blockedId } },
    { upsert: true },
  );

  const a = new Types.ObjectId(blockerId);
  const b = new Types.ObjectId(blockedId);

  await SeatRequestModel.updateMany(
    {
      status: "pending",
      $or: [
        { requesterId: a, driverId: b },
        { requesterId: b, driverId: a },
      ],
    },
    { $set: { status: "cancelled", respondedAt: new Date() } },
  );

  // Area decisions between the two are dropped: the match can no longer be
  // seen by either side, so there is nothing left for them to describe.
  await AreaMatchModel.deleteMany({
    $or: [
      { userId: a, matchedUserId: b },
      { userId: b, matchedUserId: a },
    ],
  });

  // Nobody is notified. The blocked person must not be able to tell a block
  // from somebody simply having stopped travelling.
  logger.info({ blockerId }, "user blocked");

  // Published to the blocker's own devices and to nobody else — deliberately
  // NOT to the blocked person, even though their cancelled request is
  // something they are allowed to see. They would see it on their next fetch
  // either way; a live event would make it arrive the instant the block
  // happened, and that timing is the signal this flow exists to withhold.
  publish({ kind: "user", userId: blockerId }, { type: "safety.blocked", userId: blockedId });
}

export async function unblock(blockerId: string, blockedId: string): Promise<void> {
  // Idempotent: unblocking somebody who was not blocked is a no-op.
  await BlockModel.deleteOne({ blockerId, blockedId });

  // The blocker's own devices only, for the same reason as `block`.
  publish({ kind: "user", userId: blockerId }, { type: "safety.unblocked", userId: blockedId });
}

/** Only the people the caller blocked — never who blocked them. */
export async function blockedBy(blockerId: string): Promise<PublicUser[]> {
  const rows = await BlockModel.find({ blockerId })
    .sort({ createdAt: -1 })
    .select("blockedId")
    .lean();

  if (rows.length === 0) return [];

  const users = await UserModel.find({
    _id: { $in: rows.map((row) => row.blockedId) },
  }).lean();

  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  return rows
    .map((row) => byId.get(row.blockedId.toString()))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map(toPublicUser);
}

/**
 * Help and complaints.
 *
 * The reply goes to the account's own address, not one supplied in the body:
 * otherwise this is a way to make our support address send mail to anyone.
 */
export async function submitSupport(
  userId: string,
  input: { category: string; message: string },
): Promise<{ reference: string }> {
  const user = await UserModel.findById(userId).select("email").lean();
  if (!user) throw new NotFoundError("Account not found.");

  // Short and readable, because a person quotes it back. Retried on the rare
  // collision rather than trusting four digits to be unique.
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = `GS-${randomInt(100000, 1000000)}`;
    try {
      await SupportRequestModel.create({
        userId,
        email: user.email,
        category: input.category,
        message: input.message,
        reference,
        status: "open",
      });
      logger.info({ userId, category: input.category, reference }, "support request");
      return { reference };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  throw new Error("Could not allocate a support reference");
}
