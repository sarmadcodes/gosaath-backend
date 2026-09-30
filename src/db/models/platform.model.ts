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
// Push outbox
// ---------------------------------------------------------------------------

/**
 * Pushes waiting to be delivered.
 *
 * The notification row is the durable record and is written first; this is the
 * nudge about it. They are separate rows on purpose — a push is a message to a
 * third party that can fail, be slow, or be refused, and none of that may
 * touch the notification itself or the business operation that caused it.
 *
 * Before this existed, the push was dispatched and deliberately not awaited.
 * That is correct for latency and wrong for durability: a restart between the
 * notification write and the send lost the push silently, and a provider
 * having a bad afternoon lost every push sent during it. A row here survives
 * both, and the worker retries on a backoff until it succeeds or gives up
 * loudly.
 */
const pushOutboxSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, required: true, maxlength: 40 },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 500 },
    /** Ids only. This travels through a third party's servers. */
    data: { type: Schema.Types.Mixed, default: null },

    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    /** When the worker may next pick this up. Backoff is written here. */
    nextAttemptAt: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null },
    /**
     * Why it last failed. Bounded, and never the message body — a log line is
     * not a place to reproduce what somebody was told.
     */
    lastError: { type: String, default: null, maxlength: 300 },
    /**
     * Claimed by a worker at this moment.
     *
     * A row stuck in "sending" because the process died mid-send is released
     * once this is old enough, so a crash costs a delay rather than a push.
     */
    claimedAt: { type: Date, default: null },
  },
  baseOptions,
);

/** The worker's query: what is due, oldest first. */
pushOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
/**
 * Sent rows are kept briefly for diagnosis and then removed by Mongo itself,
 * so the collection cannot grow without bound and nothing has to remember to
 * prune it.
 */
pushOutboxSchema.index({ sentAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export type PushOutboxDoc = InferSchemaType<typeof pushOutboxSchema>;
export const PushOutboxModel = model("PushOutbox", pushOutboxSchema, "pushOutbox");

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

/**
 * Append-only, enforced here rather than by convention.
 *
 * Every update and delete path Mongoose offers throws. A record of who did
 * what is worthless if it can be quietly edited afterwards, and a rule that
 * lives only in a comment is a rule the next hurried change breaks.
 *
 * Retention, if it is ever needed, is a deliberate compliance job run against
 * the raw collection — not a normal code path.
 */
const APPEND_ONLY =
  "The audit log is append-only; entries cannot be changed or removed.";

for (const operation of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  auditLogSchema.pre(operation, function () {
    throw new Error(APPEND_ONLY);
  });
}

auditLogSchema.pre("save", function (this: { isNew: boolean }) {
  // Inserting is the only permitted write.
  if (!this.isNew) throw new Error(APPEND_ONLY);
});

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
