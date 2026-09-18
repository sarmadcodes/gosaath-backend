import { Schema } from "mongoose";
import type { Weekday } from "../../contract/types.js";

/**
 * Shared schema pieces.
 *
 * Enum values are pulled from the contract's own unions wherever possible, so
 * adding a status to the client and forgetting the database becomes a compile
 * error rather than a runtime write that silently fails validation.
 */

export const WEEKDAY_VALUES: Weekday[] = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
];

/** "08:00" — a local wall-clock time, never a timestamp. See DaySchedule. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const daySchedule = new Schema(
  {
    day: { type: String, enum: WEEKDAY_VALUES, required: true },
    // Optional because a day can be outbound-only: a student with no class to
    // travel home from still travels in.
    arriveBy: { type: String, match: TIME_PATTERN },
    leaveCampusAt: { type: String, match: TIME_PATTERN },
  },
  { _id: false },
);

/**
 * Area centroid. Present on areas, never on a user.
 *
 * `2dsphere` is deliberately NOT used: that index exists for proximity
 * queries over user locations, and this product has none. Sixteen areas are
 * compared in memory in microseconds.
 */
export const centroid = new Schema(
  {
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

/**
 * Serialises `_id` to `id` and strips internals.
 *
 * The contract types use `id`, so every document that reaches a client goes
 * through this. `__v` and anything sensitive is dropped at the boundary rather
 * than remembered per-route.
 */
export const baseOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    virtuals: true,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret["id"] = ret["_id"];
      delete ret["_id"];
      return ret;
    },
  },
} as const;
