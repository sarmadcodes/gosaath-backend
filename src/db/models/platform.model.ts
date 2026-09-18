import { Schema, model, type InferSchemaType } from "mongoose";
import { baseOptions } from "./shared.js";

// ---------------------------------------------------------------------------
// Notifications and push tokens
// ---------------------------------------------------------------------------

const NOTIFICATION_KINDS = [
  "seatRequest",
  "requestAccepted",
  "requestDeclined",
  "tomorrowCommute",
  "driverUnavailable",
  "replacementAvailable",
  "rideReminder",
  "cancellation",
  "badgeUpdate",
  "institutionApproved",
];

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, required: true, maxlength: 500 },
    unread: { type: Boolean, default: true },
    /** Ids the client deep-links with. Never free-form client input. */
    payload: { type: Schema.Types.Mixed, default: null },
  },
  baseOptions,
);

// The list, newest first, with the unread count off the same index.
notificationSchema.index({ userId: 1, unread: 1, createdAt: -1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const NotificationModel = model("Notification", notificationSchema, "notifications");

/**
 * Push tokens, one row per device.
 *
 * A user has more than one device, and a device is handed to more than one
 * user over its life. So the token is the unique key, not the user: logging in
 * on a shared phone reassigns the token rather than stacking a second row that
 * would keep notifying the previous account.
 */
const pushTokenSchema = new Schema(
  {
    token: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    platform: { type: String, enum: ["ios", "android"], required: true },
    lastSeenAt: { type: Date, default: Date.now },
    /** Set when the provider reports the token dead, so delivery skips it. */
    invalidAt: { type: Date, default: null },
  },
  baseOptions,
);

pushTokenSchema.index({ token: 1 }, { unique: true });
pushTokenSchema.index({ userId: 1, invalidAt: 1 });

export type PushTokenDoc = InferSchemaType<typeof pushTokenSchema>;
export const PushTokenModel = model("PushToken", pushTokenSchema, "pushTokens");

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const preferencesSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    womenOnly: { type: Boolean, default: false },
    verifiedOnly: { type: Boolean, default: false },
    carsOnly: { type: Boolean, default: false },
    sameCampusOnly: { type: Boolean, default: true },
    autoAcceptVerified: { type: Boolean, default: false },
    pickupRadius: { type: String, default: "Same area" },
    timeWindow: { type: String, default: "30 minutes" },
  },
  baseOptions,
);

preferencesSchema.index({ userId: 1 }, { unique: true });

export type PreferencesDoc = InferSchemaType<typeof preferencesSchema>;
export const PreferencesModel = model("Preferences", preferencesSchema, "preferences");

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append-only record of every privileged action.
 *
 * Built now, before a single admin route exists. Institution activation and
 * admin assignment are exactly the actions that later need an answer to "who
 * did this", and a log added afterwards cannot answer for anything that
 * already happened.
 *
 * Nothing here may hold a secret: metadata is written by our own handlers, and
 * a token or password landing in it would be persisted indefinitely.
 */
const auditLogSchema = new Schema(
  {
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: {
      type: String,
      enum: ["member", "universityAdmin", "superAdmin"],
      required: true,
    },
    action: { type: String, required: true, maxlength: 80 },
    targetType: { type: String, required: true, maxlength: 40 },
    targetId: { type: String, default: null },
    /** Scopes the entry, so a university admin's own log can be filtered. */
    institutionId: { type: Schema.Types.ObjectId, ref: "Institution", default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
  },
  {
    ...baseOptions,
    // Only createdAt: an audit row is never updated, and carrying an
    // updatedAt would imply it could be.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ institutionId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model("AuditLog", auditLogSchema, "auditLog");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Server-owned settings and feature flags.
 *
 * NEARBY_RADIUS_KM and the contribution band live here rather than scattered
 * through business logic, so tuning them is a configuration change, not a
 * deploy.
 */
const configurationSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 80 },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, maxlength: 300 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  baseOptions,
);

configurationSchema.index({ key: 1 }, { unique: true });

export type ConfigurationDoc = InferSchemaType<typeof configurationSchema>;
export const ConfigurationModel = model("Configuration", configurationSchema, "configuration");
