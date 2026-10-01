// VENDORED FROM THE MOBILE APP — DO NOT EDIT BY HAND.
// Source: GoSaath/src/data/events.ts
// Re-copy with `npm run contract:sync`; `npm run contract:check` fails
// CI when this drifts from the app's copy. Re-declaring these types by
// hand is how response shapes silently diverge from the client.

/**
 * Every live event the server can send, in one place.
 *
 * One catalogue rather than a string literal at each call site, for a dull
 * reason that matters at three in the morning: a typo in a published event
 * name is silent. Nothing throws, no test fails, and one screen simply stops
 * updating. Here, the compiler catches it.
 *
 * **What an event carries.** Ids, a kind, and at most a count. Never a phone
 * number, never a name, never an area, never the body of a notification.
 * Two reasons: an event fans out to every device a person has signed in on,
 * and an admin event fans out to every administrator of an institution — so
 * the audience of a payload is wider than the audience of the request that
 * caused it. The event says "something about ride X changed"; the client asks
 * for ride X through the ordinary authorised endpoint, which applies the
 * ordinary privacy rules. That keeps exactly one place deciding who may see
 * what, instead of two.
 */

export type RealtimeEvent =
  // --- Notifications ------------------------------------------------------
  /** A row was added to the notification list. Carries the new unread count. */
  | { type: "notification.created"; unread: number }
  | { type: "notification.read"; unread: number }

  // --- Seat requests ------------------------------------------------------
  | { type: "seatRequest.created"; requestId: string; rideId: string }
  | { type: "seatRequest.accepted"; requestId: string; rideId: string }
  | { type: "seatRequest.declined"; requestId: string; rideId: string }
  | { type: "seatRequest.cancelled"; requestId: string; rideId: string }

  // --- Matching -----------------------------------------------------------
  | { type: "match.created"; matchId: string }
  | { type: "match.updated"; matchId: string }
  | { type: "match.removed"; matchId: string }

  // --- Rides and commutes -------------------------------------------------
  | { type: "ride.created"; rideId: string }
  | { type: "ride.updated"; rideId: string }
  | { type: "ride.confirmed"; rideId: string }
  | { type: "ride.cancelled"; rideId: string }
  | { type: "ride.seatsChanged"; rideId: string; seatsLeft: number }
  | { type: "commute.updated"; commuteId: string }
  | { type: "driverUnavailable"; rideId: string; commuteId: string }
  | { type: "replacementAvailable"; commuteId: string; options: number }

  // --- Verification and safety -------------------------------------------
  | { type: "verification.updated"; status: "pending" | "approved" | "rejected" }
  /**
   * A safety alert was raised, acknowledged or closed.
   *
   * Admin-facing. Carries the alert id and how many are open, so the safety
   * centre and its badge move together; who raised it comes from the
   * authorised endpoint like everything else.
   */
  | { type: "safety.updated"; alertId: string; open: number }
  | { type: "safety.blocked"; userId: string }
  | { type: "safety.unblocked"; userId: string }
  | { type: "account.suspended" }
  | { type: "account.restored" }

  // --- Admin channel ------------------------------------------------------
  | { type: "admin.verification.created"; pending: number }
  | { type: "admin.verification.updated"; pending: number }
  | { type: "admin.report.created"; open: number }
  | { type: "admin.report.updated"; open: number }
  | { type: "admin.member.changed"; memberId: string }
  | { type: "admin.institution.changed"; institutionId: string }

  // --- Transport ----------------------------------------------------------
  /**
   * "You have been away; refetch what is on screen."
   *
   * Sent when a reconnecting client asks to resume from an event that has
   * already fallen out of the replay buffer, so we cannot honestly tell it
   * what it missed. A client that treats this as a full refresh is correct;
   * one that ignores it shows stale data, which is the failure this whole
   * mechanism exists to prevent.
   */
  | { type: "resync" };

export type RealtimeEventType = RealtimeEvent["type"];
