import type { Weekday } from "../contract/types.js";

/**
 * Dates, always in the product's timezone.
 *
 * Two different kinds of value run through this app and must never be
 * conflated:
 *
 *   a recurring local time   "08:00" — what a timetable says. No date, no
 *                            offset. It means eight o'clock in Karachi
 *                            whatever the server is doing.
 *   an absolute instant      a RideInstance's date, stored as UTC
 *
 * Every conversion between them happens here. `process.env.TZ` is pinned at
 * boot, but nothing below relies on it: these use an explicit timezone, so a
 * container that ignores TZ, or a test that changes it, cannot silently shift
 * everybody's commute.
 */

export const TIMEZONE = "Asia/Karachi";

const WEEKDAY_BY_INDEX: Weekday[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

/**
 * The calendar parts of an instant, as seen in Karachi.
 *
 * `Intl` rather than the Date getters, because those answer in whatever zone
 * the host happens to be in.
 */
function partsIn(instant: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
} {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);

  // Derived from the Karachi calendar date rather than read from the instant,
  // so a time late in the UTC evening does not report yesterday's weekday.
  const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return {
    year,
    month,
    day,
    hour: Number(parts["hour"]),
    minute: Number(parts["minute"]),
    weekday: WEEKDAY_BY_INDEX[weekdayIndex] as Weekday,
  };
}

/**
 * The UTC offset of Karachi at a given instant, in minutes.
 *
 * Computed rather than hardcoded to +05:00. Pakistan has no daylight saving
 * today, which is exactly the kind of fact that quietly stops being true — and
 * a hardcoded offset would then shift every commute by an hour with nothing to
 * point at.
 */
function offsetMinutes(instant: Date): number {
  const parts = partsIn(instant);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  // Seconds and milliseconds are dropped by the formatter, so compare against
  // the instant truncated the same way.
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (asUtc - truncated) / 60_000;
}

/** The weekday in Karachi. */
export function weekdayOf(instant: Date): Weekday {
  return partsIn(instant).weekday;
}

/**
 * Local midnight in Karachi for the day containing `instant`, as a UTC Date.
 *
 * This is the canonical form of a RideInstance's `date`. Anchoring to midnight
 * makes a date one value rather than a range, which is what lets
 * `{commuteId, date}` work as a unique key — the thing that makes instance
 * generation idempotent.
 */
export function startOfDay(instant: Date): Date {
  const { year, month, day } = partsIn(instant);
  // First approximation using the offset at the instant, then corrected. One
  // pass is enough unless a DST boundary falls between the two, which is why
  // the second read exists at all.
  const naive = Date.UTC(year, month - 1, day);
  const guess = new Date(naive - offsetMinutes(instant) * 60_000);
  const corrected = naive - offsetMinutes(guess) * 60_000;
  return new Date(corrected);
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Local midnight for each of the next `count` days, starting today.
 *
 * Built by stepping a day at a time and re-anchoring, rather than adding 24
 * hours repeatedly — the latter drifts the moment an offset changes.
 */
export function upcomingDays(count: number, from = new Date()): Date[] {
  const days: Date[] = [];
  let cursor = startOfDay(from);
  for (let i = 0; i < count; i++) {
    days.push(cursor);
    cursor = startOfDay(addDays(cursor, 1));
  }
  return days;
}

/** "08:00" → 480. Used to compare timetable entries. */
export function minutesFromTime(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 480 → "08:00". */
export function timeFromMinutes(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** An ISO calendar date in Karachi, e.g. "2026-09-22". */
export function isoDate(instant: Date): string {
  const { year, month, day } = partsIn(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The Monday-anchored week containing `instant`, as seven local midnights. */
export function weekOf(instant: Date = new Date()): Date[] {
  const today = startOfDay(instant);
  const index = WEEKDAY_BY_INDEX.indexOf(weekdayOf(today));
  // Monday-first, matching how a timetable is read.
  const sinceMonday = (index + 6) % 7;
  const monday = startOfDay(addDays(today, -sinceMonday));

  const days: Date[] = [];
  let cursor = monday;
  for (let i = 0; i < 7; i++) {
    days.push(cursor);
    cursor = startOfDay(addDays(cursor, 1));
  }
  return days;
}
