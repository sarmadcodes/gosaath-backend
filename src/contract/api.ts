// VENDORED FROM THE MOBILE APP — DO NOT EDIT BY HAND.
// Source: GoSaath/src/services/api.ts
// Re-copy with `npm run contract:sync`; `npm run contract:check` fails
// CI when this drifts from the app's copy. Re-declaring these types by
// hand is how response shapes silently diverge from the client.

import type {
  AppNotification,
  Area,
  AreaSuggestion,
  ProximityEstimate,
  RoutePreview,
  Campus,
  Commute,
  CommuteDay,
  CommuteIntent,
  CommuteMatch,
  CommuteMember,
  DaySchedule,
  Institution,
  PublicUser,
  InstitutionRequest,
  InstitutionType,
  MatchSummary,
  RideListing,
  SeatRequest,
  User,
  UserType,
  Vehicle,
  VehicleType,
  Weekday,
} from "./types.js";

/**
 * The contract between the UI and whatever is serving it.
 *
 * Every method is async and returns plain domain types, so the mock
 * implementation can be replaced by an HTTP client talking to the Node/Mongo
 * backend without touching a single screen. Screens must only ever import
 * `api` from "@/services", never a concrete implementation.
 */

export type RegisterInput = {
  name: string;
  email: string;
  password: string;
  phone: string;
  photoUrl?: string | null;
  userType: UserType;
  institutionId: string;
  campusId: string;
  areaId: string;
};

export type AuthSession = {
  token: string;
  user: User;
};

export interface AuthApi {
  /** Creates the account and sends an OTP to the institution email. */
  register(input: RegisterInput): Promise<{ pendingEmail: string }>;
  /** Confirms the institution email and activates the account. */
  verifyEmailOtp(email: string, code: string): Promise<AuthSession>;
  resendOtp(email: string): Promise<void>;
  login(email: string, password: string): Promise<AuthSession>;
  requestPasswordReset(email: string): Promise<void>;
  logout(): Promise<void>;
  /** Restores a stored session on app launch, or null when signed out. */
  restore(): Promise<AuthSession | null>;
}

export interface InstitutionsApi {
  search(query: string, type?: InstitutionType): Promise<Institution[]>;
  campuses(institutionId: string): Promise<Campus[]>;
  /** Submits an institution for admin review. Never creates one directly. */
  request(input: {
    name: string;
    type: InstitutionType;
    website?: string;
    campusName?: string;
    requestedByEmail: string;
  }): Promise<InstitutionRequest>;
}

/** Where to send the bytes, and what to call the file afterwards. */
export type UploadTarget = {
  url: string;
  headers: Record<string, string>;
  key: string;
  expiresInSeconds: number;
};

export interface UploadsApi {
  /**
   * Asks permission to upload one file, and says where to put it.
   *
   * The bytes then go straight to storage, not through the API: a photo
   * relayed through the server is the same photo, slower, and a memory spike
   * per upload.
   */
  sign(input: {
    kind: "photo" | "badge";
    contentType: string;
    bytes: number;
  }): Promise<UploadTarget>;
}

export interface MeApi {
  get(): Promise<User>;
  update(patch: Partial<User>): Promise<User>;
  /** Takes the key from a finished upload, or null to remove the photo. */
  setPhoto(key: string | null): Promise<User>;
  /** Submits proof for the optional verified badge, by upload key. */
  requestBadge(key: string): Promise<User>;
  addInstitution(institutionId: string): Promise<User>;
  removeInstitution(institutionId: string): Promise<User>;
  /**
   * Closes the account for good.
   *
   * The password is asked for again because this cannot be undone and a
   * borrowed unlocked phone should not be enough to do it.
   *
   * Personal details go; the safety record stays, unlinked from a name. A
   * report has to survive the reported person deleting their account, or
   * deleting it becomes the way to erase what you did.
   */
  deleteAccount(password: string): Promise<void>;
}

export type CommuteInput = {
  intent: CommuteIntent;
  institutionId: string;
  campusId: string;
  originAreaId: string;
  /** Per-day times. Days are implied by the entries present. */
  schedule: DaySchedule[];
  direction: Commute["direction"];
  vehicleId?: string;
  seatsOffered?: number;
  contribution?: number;
  womenOnly: boolean;
};

export interface CommutesApi {
  mine(): Promise<Commute | null>;
  create(input: CommuteInput): Promise<Commute>;
  update(id: string, patch: Partial<CommuteInput>): Promise<Commute>;
  cancel(id: string): Promise<void>;
}

export interface MatchesApi {
  /** Drives the Home match card, including its empty and partial states. */
  summary(): Promise<MatchSummary>;
  list(): Promise<CommuteMatch[]>;
  /** Records whether the viewer accepts the other person's area. */
  setAreaMatch(
    matchId: string,
    status: "accepted" | "rejected",
  ): Promise<CommuteMatch>;
}

export type RideSearch = {
  /** Defaults to the user's primary institution and campus. */
  institutionId?: string;
  campusId?: string;
  day?: Weekday;
  time?: string;
  vehicleType?: VehicleType;
  womenOnly?: boolean;
};

export interface RidesApi {
  search(params: RideSearch): Promise<RideListing[]>;
  /**
   * Everyone at the same institution and campus offering seats from an area
   * within `NEARBY_RADIUS_KM` of yours, regardless of time.
   *
   * Distinct from `search`, which matches a schedule. Someone who cannot find
   * a time-compatible ride still wants to see who is out there — and on a
   * campus that is still filling up, that list is the only one with anything
   * in it. Institution and campus remain hard constraints; only time is
   * relaxed. An optional `day` narrows it to people who travel that day.
   */
  nearby(params: { day?: Weekday }): Promise<RideListing[]>;
  get(id: string): Promise<RideListing | null>;
  requestSeat(rideId: string, seats: number): Promise<SeatRequest>;
  /** Requests other people have sent you, for seats you are offering. */
  incomingRequests(): Promise<SeatRequest[]>;
  /** Requests you have sent to other people, awaiting their reply. */
  sentRequests(): Promise<SeatRequest[]>;
  respondToRequest(
    requestId: string,
    action: "accept" | "decline",
  ): Promise<SeatRequest>;
}

export type VehicleInput = {
  type: VehicleType;
  model: string;
  plate: string;
  colour: string;
  imageUri?: string | null;
};

export interface VehiclesApi {
  list(): Promise<Vehicle[]>;
  save(input: VehicleInput & { id?: string }): Promise<Vehicle>;
  remove(id: string): Promise<void>;
}

export interface AreasApi {
  list(city?: string): Promise<Area[]>;
}

/**
 * Location lookups, kept behind the same seam as everything else.
 *
 * A Google Maps-backed implementation slots in here without any screen
 * changing. Note what is absent: there is no `currentPosition`, no watch, no
 * coordinates in or out. Everything resolves to an area, because that is the
 * only granularity the product stores.
 */
export interface LocationApi {
  /** Type-ahead over areas and landmarks. */
  search(query: string): Promise<AreaSuggestion[]>;
  /** Recently chosen areas, so the common case is one tap. */
  recent(): Promise<AreaSuggestion[]>;
  /** Approximate closeness between two areas, as a phrase. */
  proximity(fromAreaId: string, toAreaId: string): Promise<ProximityEstimate>;
  /** Origin area to destination campus, for the route preview. */
  route(originAreaId: string, campusId: string): Promise<RoutePreview>;
}

export interface CommuteWeekApi {
  /** The current week expanded from the commute template. */
  week(commuteId: string): Promise<CommuteDay[]>;
  members(commuteId: string): Promise<CommuteMember[]>;
  skipDay(commuteId: string, day: Weekday): Promise<CommuteDay[]>;
  /** Dates the owner cannot drive, which orphans those ride instances. */
  setUnavailable(commuteId: string, days: Weekday[]): Promise<CommuteDay[]>;
  replacements(commuteId: string, day: Weekday): Promise<RideListing[]>;
}

export interface NotificationsApi {
  list(): Promise<AppNotification[]>;
  markRead(id: string): Promise<void>;
  /**
   * Stores the device's push token against the account.
   *
   * Called after the user grants permission, and again whenever Expo rotates
   * the token. The backend should treat it as upsert-by-token and allow
   * several per user — people have more than one device.
   */
  registerPushToken(token: string, platform: "ios" | "android"): Promise<void>;
  /** Called on logout so a shared device stops receiving the last user's alerts. */
  unregisterPushToken(token: string): Promise<void>;
}

export interface SafetyApi {
  report(input: {
    reportedUserId?: string;
    category: string;
    detail?: string;
  }): Promise<void>;
  block(userId: string): Promise<void>;
  unblock(userId: string): Promise<void>;
  blocked(): Promise<PublicUser[]>;
}

/**
 * Help requests. Separate from `safety.report`: that is about a person and
 * goes to moderation, this is about the product and goes to support. Mixing
 * them would bury genuine safety reports in password-reset queries.
 */
export interface SupportApi {
  submit(input: {
    category: string;
    message: string;
    /** Filled from the account so the user does not retype it. */
    email: string;
  }): Promise<{ reference: string }>;
}

export type MatchPreferences = {
  womenOnly: boolean;
  verifiedOnly: boolean;
  carsOnly: boolean;
  sameCampusOnly: boolean;
  autoAcceptVerified: boolean;
  pickupRadius: string;
  timeWindow: string;
};

export interface PreferencesApi {
  get(): Promise<MatchPreferences>;
  update(patch: Partial<MatchPreferences>): Promise<MatchPreferences>;
}

export interface Api {
  uploads: UploadsApi;
  auth: AuthApi;
  institutions: InstitutionsApi;
  me: MeApi;
  commutes: CommutesApi;
  commuteWeek: CommuteWeekApi;
  matches: MatchesApi;
  rides: RidesApi;
  vehicles: VehiclesApi;
  areas: AreasApi;
  location: LocationApi;
  notifications: NotificationsApi;
  safety: SafetyApi;
  support: SupportApi;
  preferences: PreferencesApi;
}
