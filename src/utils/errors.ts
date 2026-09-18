/**
 * Typed application errors.
 *
 * Every error the API returns is one of these. A raw driver or library error
 * reaching the client leaks implementation detail — `E11000 duplicate key
 * index: users.email_1` tells an attacker the collection name, the index name
 * and that the address exists. The handler maps these to status codes and a
 * safe message; anything unrecognised becomes a generic 500.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "BUSINESS_RULE"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL";

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: ErrorCode;

  /**
   * Safe to send to the client. Anything sensitive belongs in `context`,
   * which is logged and never serialised into the response.
   */
  readonly expose = true;
  readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.context = context;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Malformed request: bad shape, bad types, unknown fields. */
export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = "VALIDATION_FAILED" as const;
  /** Field-level detail, safe to return so a client can correct itself. */
  readonly fields?: Array<{ path: string; message: string }>;

  constructor(
    message = "The request could not be processed.",
    fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.fields = fields;
  }
}

/** No credentials, or credentials that no longer prove anything. */
export class AuthenticationError extends AppError {
  readonly statusCode = 401;
  readonly code = "UNAUTHENTICATED" as const;

  constructor(message = "Sign in to continue.") {
    super(message);
  }
}

/**
 * Authenticated, but not allowed.
 *
 * Deliberately says nothing about whether the target exists. Where existence
 * itself is sensitive — another institution's member — throw NotFoundError
 * instead, so the response cannot be used to enumerate ids.
 */
export class AuthorizationError extends AppError {
  readonly statusCode = 403;
  readonly code = "FORBIDDEN" as const;

  constructor(message = "You do not have access to this.") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND" as const;

  constructor(message = "Not found.") {
    super(message);
  }
}

/** The request is valid but conflicts with current state. */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "CONFLICT" as const;

  constructor(message = "That conflicts with something that already exists.") {
    super(message);
  }
}

/** Well-formed, but semantically impossible. */
export class UnprocessableError extends AppError {
  readonly statusCode = 422;
  readonly code = "UNPROCESSABLE" as const;

  constructor(message = "That request cannot be completed.") {
    super(message);
  }
}

/** Body exceeded the route's limit. Never buffered, so never inspected. */
export class PayloadTooLargeError extends AppError {
  readonly statusCode = 413;
  readonly code = "PAYLOAD_TOO_LARGE" as const;

  constructor(message = "That request is too large.") {
    super(message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  readonly statusCode = 415;
  readonly code = "UNSUPPORTED_MEDIA_TYPE" as const;

  constructor(message = "That content type is not supported.") {
    super(message);
  }
}

export class RateLimitError extends AppError {
  readonly statusCode = 429;
  readonly code = "RATE_LIMITED" as const;

  constructor(message = "Too many attempts. Try again shortly.") {
    super(message);
  }
}

/**
 * A product rule said no.
 *
 * Distinct from validation: the input was fine, the domain refused. "The last
 * seat has gone" is this, not a 400.
 */
export class BusinessRuleError extends AppError {
  readonly statusCode = 409;
  readonly code = "BUSINESS_RULE" as const;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/** Something we depend on is down: database, email, push. */
export class DependencyError extends AppError {
  readonly statusCode = 503;
  readonly code = "DEPENDENCY_UNAVAILABLE" as const;

  constructor(message = "A service we depend on is unavailable.") {
    super(message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Translates a MongoDB error into something safe.
 *
 * Only duplicate-key is worth surfacing, and only as a conflict — the driver's
 * message names the index, so it is never passed through.
 */
export function fromMongoError(error: unknown): AppError | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; name?: unknown };
  if (candidate.code === 11000) {
    return new ConflictError("That already exists.");
  }
  if (candidate.name === "MongoServerSelectionError") {
    return new DependencyError("The database is unavailable.");
  }
  return null;
}
