import { logger } from "../../utils/logger.js";
import {
  AttendanceModel,
  RideInstanceModel,
  SafetyAlertModel,
  UserModel,
} from "../../db/models/index.js";
import { NotFoundError } from "../../utils/errors.js";
import { notifyQuietly } from "../notifications/notification.service.js";
import { publishAll } from "../realtime/hub.js";
import type { Channel } from "../realtime/events.js";

/**
 * The help button.
 *
 * What this does, precisely, because the gap between what a safety feature
 * does and what a frightened person assumes it does is the most dangerous
 * thing in the product:
 *
 *   **The app** records the alert, tells every administrator of the
 *   institution immediately, and shows the real emergency numbers.
 *
 *   **The phone** places the call. The app hands the number to the dialer and
 *   the operating system takes over; GoSaath is not in that call and cannot be.
 *
 *   **Nothing external** is contacted. There is no control room, no dispatch,
 *   no SMS to a next of kin — that would need a provider we do not have — and
 *   no location, because the product holds none for anybody.
 *
 * Somebody deciding not to dial 15 because an app implied help was already
 * coming would be a failure this code caused. So the copy the app shows leads
 * with the phone number, and this service never claims more than a record and
 * a notification.
 */

/**
 * Pakistan's emergency numbers, served rather than hardcoded in the app.
 *
 * Here so they can be corrected without an App Store release — a wrong
 * emergency number shipped in a binary is wrong for however long review takes.
 */
export const EMERGENCY_CONTACTS = [
  { label: "Police", number: "15" },
  { label: "Rescue 1122", number: "1122" },
  { label: "Ambulance (Edhi)", number: "115" },
] as const;

export type RaisedAlert = {
  id: string;
  /** What the app shows next: the numbers, in the order to try them. */
  contacts: typeof EMERGENCY_CONTACTS;
  /** How many administrators were told, so the screen can say so honestly. */
  notified: number;
};

/**
 * Raises an alert.
 *
 * Deliberately tolerant about its input. Somebody pressing this is not in a
 * position to pick the right ride from a list, so the ride is optional and a
 * wrong one is not worth an error — the alert is what matters and it is
 * written first.
 */
export async function raiseAlert(
  userId: string,
  input: { kind: "sos" | "feelingUnsafe"; rideInstanceId?: string | undefined; note?: string | undefined },
): Promise<RaisedAlert> {
  const user = await UserModel.findById(userId)
    .select("name institutionId")
    .lean();
  if (!user) throw new NotFoundError("Account not found.");

  // Checked rather than trusted, but a ride that does not belong to them is
  // dropped rather than refused: the alert still goes out.
  let rideInstanceId: string | null = null;
  if (input.rideInstanceId) {
    const onIt = await AttendanceModel.findOne({
      rideInstanceId: input.rideInstanceId,
      userId,
    })
      .select("_id")
      .lean();
    const driving = await RideInstanceModel.findOne({
      _id: input.rideInstanceId,
      driverId: userId,
    })
      .select("_id")
      .lean();
    if (onIt || driving) rideInstanceId = input.rideInstanceId;
  }

  const alert = await SafetyAlertModel.create({
    userId,
    institutionId: user.institutionId,
    rideInstanceId,
    kind: input.kind,
    note: input.note ?? null,
    status: "open",
  });

  logger.warn(
    { alertId: alert._id.toString(), userId, kind: input.kind, hasRide: Boolean(rideInstanceId) },
    "safety alert raised",
  );

  // Told immediately, and by name — this is the one place an admin event
  // carries a person's identity, because an administrator cannot act on "a
  // member needs help" without knowing which member.
  const admins = await UserModel.find({
    institutionId: user.institutionId,
    role: { $in: ["universityAdmin", "superAdmin"] },
    suspendedAt: null,
    deletedAt: null,
  })
    .select("_id")
    .lean();

  for (const admin of admins) {
    await notifyQuietly({
      userId: admin._id,
      kind: "safetyAlert",
      title: input.kind === "sos" ? "Someone has asked for help" : "Someone reported feeling unsafe",
      body: `${user.name} raised a safety alert. Open the safety centre.`,
      payload: { alertId: alert._id.toString() },
    });
  }

  const channels: Channel[] = [
    { kind: "institution", institutionId: user.institutionId.toString() },
    { kind: "platform" },
  ];
  publishAll(channels, {
    type: "safety.updated",
    alertId: alert._id.toString(),
    open: await SafetyAlertModel.countDocuments({
      institutionId: user.institutionId,
      status: "open",
    }),
  });

  return {
    id: alert._id.toString(),
    contacts: EMERGENCY_CONTACTS,
    notified: admins.length,
  };
}

/** The person's own alerts, so the app can show one still being looked at. */
export async function myAlerts(userId: string) {
  const rows = await SafetyAlertModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return rows.map((row) => ({
    id: row._id.toString(),
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt,
    // Deliberately not the resolution text: that is an administrator's note to
    // other administrators, and may name a third party.
  }));
}
