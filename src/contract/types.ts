// VENDORED FROM THE MOBILE APP — DO NOT EDIT BY HAND.
// Source: GoSaath/src/data/types.ts
// Re-copy with `npm run contract:sync`; `npm run contract:check` fails
// CI when this drifts from the app's copy. Re-declaring these types by
// hand is how response shapes silently diverge from the client.

/**
 * Domain types. These are the contracts the Node/Mongo backend will implement.
 *
 * Ids are strings so they map cleanly onto Mongo ObjectIds. Anything the API
 * will return as a populated sub-document is typed as a nested object here,
 * and anything it will return as a reference is typed as a bare `...Id`.
 */

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export const WEEKDAYS: Weekday[] = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
];

// ---------------------------------------------------------------------------
// Institution and campus
// ---------------------------------------------------------------------------

export type InstitutionType = "university" | "college" | "school" | "organisation";

export type Institution = {
  id: string;
  name: string;
  /** Short form shown where space is tight, e.g. "SZABIST". */
  shortName?: string;
  type: InstitutionType;
  /** Used to validate institution email at registration. */
  emailDomains: string[];
  city: string;
  active: boolean;
  /**
   * Drives the app accent once this institution is selected, so the product
   * takes on the user's own campus identity rather than a generic brand.
   */
  brandColor: string;
  /** Pins an institution to the top of the picker. SZABIST for first launch. */
  featured?: boolean;
};

export type Campus = {
  id: string;
  institutionId: string;
  name: string;
  /** Approximate area the campus sits in. Never a precise address. */
  areaId?: string;
};

/** A user-submitted institution that an admin has to review before it exists. */
export type InstitutionRequest = {
  id: string;
  name: string;
  type: InstitutionType;
  website?: string;
  campusName?: string;
  requestedByEmail: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export type Area = {
  id: string;
  name: string;
  city: string;
};

/**
 * A place the user can pick as the start of their commute.
 *
 * Deliberately resolves to an `areaId`, not coordinates. A future Google Maps
 * search will return richer candidates, but whatever the user types or taps is
 * snapped to an area before it is stored — the product never holds a street
 * address, a latitude or a longitude for anybody.
 */
export type AreaSuggestion = {
  areaId: string;
  /** Area name as it will be shown and stored, e.g. "Gulshan-e-Iqbal". */
  name: string;
  city: string;
  /** Optional landmark that helps disambiguate, e.g. "Near NIPA Chowrangi". */
  hint?: string;
};

/**
 * How close two commuters are, as a phrase rather than a number.
 *
 * Travel time is a backend/location-service decision, and false precision
 * ("12.37 km") implies a tracking accuracy this product deliberately does not
 * have. The UI renders whatever label it is given.
 */
export type ProximityEstimate = {
  /** Human phrase, e.g. "~12 min away" or "About 15 min". */
  label: string;
  /**
   * Approximate straight-line distance between the two areas.
   *
   * Used to decide what counts as "nearby" — never rendered. Showing "2.4 km"
   * would imply a precision this product does not have; the `label` is what
   * the UI displays.
   */
  distanceKm?: number;
  /** Where the two routes run together, e.g. "Near Shahrah-e-Faisal". */
  overlapHint?: string;
  /** True while this is an approximation rather than a routed result. */
  approximate: boolean;
};

/** Origin area to destination campus, for the route preview. */
export type RoutePreview = {
  originArea: string;
  destinationCampus: string;
  /** Optional corridor description, e.g. "Route near Shahrah-e-Faisal". */
  via?: string;
  estimate?: ProximityEstimate;
};

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export type UserType = "student" | "teacher" | "employee";

/**
 * Who someone is to the platform, as opposed to what they are at their
 * institution (`UserType`).
 *
 * The two are independent on purpose: a university admin is also a member of
 * their own institution and commutes like anybody else. Role decides what
 * they may administer, never how they are matched.
 *
 *   superAdmin      → platform-wide. Onboards institutions, assigns admins.
 *   universityAdmin → exactly one institution. Never sees another's data.
 *   member          → students and faculty. The mobile app.
 *
 * Mobile is a `member` surface. The admin roles exist here now so that
 * institution scoping is structural from the start rather than retrofitted:
 * see SYSTEM.md section 11.
 */
export type Role = "member" | "universityAdmin" | "superAdmin";

/**
 * What a role is allowed to act on.
 *
 * Every admin query must be built from a scope rather than from a raw
 * institution id passed in by the caller — that is what stops a SZABIST admin
 * from reading another institution's students by changing a parameter.
 */
export type AdminScope =
  | { kind: "platform" }
  | { kind: "institution"; institutionId: string };

/**
 * The optional, admin-reviewed badge. Institution email is the account
 * requirement and is not represented here, because every account has it.
 */
export type BadgeStatus = "none" | "pending" | "approved" | "rejected";

export type User = {
  id: string;
  name: string;
  email: string;
  phone: string;
  photoUrl?: string | null;
  userType: UserType;
  institutionId: string;
  campusId: string;
  /** Approximate home area. Exact address is never collected or stored. */
  areaId: string;
  badgeStatus: BadgeStatus;
  /** Institutions the user has added beyond their primary one. */
  additionalInstitutionIds: string[];
  /**
   * Platform role. Absent or "member" for everyone on mobile. Present so the
   * admin surfaces can be built against the same user record later.
   */
  role?: Role;
};

/**
 * What another user is allowed to see. Deliberately minimal: no rating, no
 * ride count, no join date, no full profile. There are no public profiles.
 */
export type PublicUser = {
  id: string;
  // Note: no `role` here, and none is coming. What someone administers is not
  // another commuter's business, and exposing it would leak staff identities.
  /** First name only. Full names are not exposed to other commuters. */
  firstName: string;
  photoUrl?: string | null;
  verified: boolean;
};

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export type VehicleType = "car" | "bike";

export type Vehicle = {
  id: string;
  ownerId: string;
  type: VehicleType;
  /** Model or common name, e.g. "Toyota Corolla GLi". */
  model: string;
  plate: string;
  colour: string;
  /** One image showing the front of the vehicle and the plate. */
  imageUrl?: string | null;
};

// ---------------------------------------------------------------------------
// Commute: the recurring template
// ---------------------------------------------------------------------------

/** Which legs of the daily journey this commute covers. */
export type CommuteDirection = "going" | "returning" | "both";

/** Whether the user wants a seat, is offering seats, or both. */
export type CommuteIntent = "find" | "offer" | "both";

/**
 * Times for a single weekday, expressed as campus times rather than departure
 * times.
 *
 * This is deliberate. A student knows when their class starts, not when a
 * stranger would need to leave home to get them there — that depends on the
 * driver's area and the traffic. Both sides therefore state the same thing:
 * when they must be on campus, and when they are done. Matching compares
 * those, and the driver works backwards from them.
 *
 * Real timetables are not uniform: a student may have an 8:00 Monday and a
 * 10:00 Wednesday, and may not travel home at all on some days. So the
 * schedule is per day rather than one time applied to every selected day.
 *
 * Matching therefore happens per day too. Two people can match on Monday and
 * Wednesday but not Tuesday, and that is a normal outcome, not an edge case.
 */
export type DaySchedule = {
  day: Weekday;
  /** Class start: the time they need to BE on campus by. */
  arriveBy?: string;
  /** Class end: when they leave campus. Absent if not travelling back. */
  leaveCampusAt?: string;
};

export type Commute = {
  id: string;
  ownerId: string;
  intent: CommuteIntent;

  institutionId: string;
  campusId: string;
  originAreaId: string;

  /** One entry per day the user travels. The days themselves are implied. */
  schedule: DaySchedule[];
  direction: CommuteDirection;

  /** Only meaningful when intent includes offering. */
  vehicleId?: string;
  seatsOffered?: number;
  contribution?: number;

  womenOnly: boolean;
  status: "active" | "paused" | "cancelled";
};

// ---------------------------------------------------------------------------
// Ride instance: one concrete day, generated from a Commute
// ---------------------------------------------------------------------------

export type AttendanceStatus =
  | "confirmed"
  | "pending"
  | "skipped"
  | "cancelled"
  | "noDriver";

export type CommuteDay = {
  day: Weekday;
  date: string;
  status: AttendanceStatus;
};

export type CommuteMemberRole = "driver" | "passenger";

export type CommuteMember = {
  user: PublicUser;
  role: CommuteMemberRole;
  /** Whether they are travelling on the next scheduled run. */
  travellingNext: boolean;
  /**
   * Shared so the group can actually reach each other — the same gate as
   * `CommuteMatch.contactPhone`, and for the same reason it is not on
   * `PublicUser`.
   */
  contactPhone?: string;
};

// ---------------------------------------------------------------------------
// Ride listings, as shown in Find a Ride
// ---------------------------------------------------------------------------

export type RideListing = {
  id: string;
  commuteId: string;
  driver: PublicUser;

  vehicleType: VehicleType;
  /** Model shown on the detail screen only, not on the card. */
  vehicleModel?: string;

  originArea: string;
  destinationCampus: string;

  /** Per-day times. May differ from day to day. */
  schedule: DaySchedule[];
  direction: CommuteDirection;

  seatsAvailable: number;
  contribution: number;
  womenOnly: boolean;

  /** Same institution and campus as the viewer. Always true by default. */
  sameCampus: boolean;
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Whether the viewer has decided the other person's area works for them.
 * Persisted so the same pairing is not asked about repeatedly.
 */
export type AreaMatchStatus = "pending" | "accepted" | "rejected";

export type CommuteMatch = {
  id: string;
  user: PublicUser;
  /** Their general area. Never an address. */
  area: string;
  campusName: string;
  /** Their per-day times, so the viewer can see which days actually line up. */
  schedule: DaySchedule[];
  /** Days where both sides' times are compatible. Computed server-side. */
  matchingDays: Weekday[];
  intent: CommuteIntent;
  vehicleType?: VehicleType;
  seatsAvailable?: number;
  contribution?: number;
  /**
   * The listing to request a seat on. Present only when they are offering and
   * still have seats free, so the match screen can ask for a specific ride
   * rather than dropping the user into a generic search.
   */
  rideId?: string;
  /**
   * How many people have already taken a seat on this arrangement.
   *
   * Deliberately phrased as "joined", not "agreed": the server knows a request
   * was accepted, it cannot know the two of them actually settled anything
   * between themselves. Do not render this as confirmation of an agreement.
   */
  seatsTaken?: number;
  /**
   * Their mobile number, served only for people you are actually matched with.
   *
   * It lives on the match rather than on `PublicUser` on purpose: `PublicUser`
   * is the shape everyone is exposed as everywhere, and a number does not
   * belong in it. A match is a narrower, mutual-enough context.
   */
  contactPhone?: string;
  areaMatch: AreaMatchStatus;
  /**
   * How close they are, computed by the location service. Optional because
   * matching works without it — the UI must render fine when it is absent,
   * and must never derive its own figure.
   */
  proximity?: ProximityEstimate;
};

/**
 * The Home match card is driven by this, so the empty and partial cases are
 * first-class rather than an absence of data.
 */
export type MatchSummaryState =
  | "matches"
  | "noDayMatch"
  | "noTimeMatch"
  | "noCommute"
  | "none";

export type MatchSummary = {
  state: MatchSummaryState;
  count: number;
  campusName: string;
};

// ---------------------------------------------------------------------------
// Requests and notifications
// ---------------------------------------------------------------------------

export type SeatRequest = {
  id: string;
  user: PublicUser;
  originArea: string;
  destinationCampus: string;
  schedule: DaySchedule[];
  direction: CommuteDirection;
  seats: number;
  contribution: number;
  status: "pending" | "accepted" | "declined";
};

export type NotificationKind =
  | "seatRequest"
  | "requestAccepted"
  | "requestDeclined"
  | "tomorrowCommute"
  | "driverUnavailable"
  | "replacementAvailable"
  | "rideReminder"
  | "cancellation"
  | "badgeUpdate"
  | "institutionApproved";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  time: string;
  unread: boolean;
};
