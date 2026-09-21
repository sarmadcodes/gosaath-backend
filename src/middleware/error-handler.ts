import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  UnprocessableError,
  UnsupportedMediaTypeError,
  ValidationError,
  fromMongoError,
  isAppError,
} from "../utils/errors.js";
import { env } from "../config/env.js";

/**
 * The single place an error becomes a response.
 *
 * Every route relies on this rather than catching and shaping its own, so the
 * body is identical everywhere and nothing internal escapes by accident.
 */

type ErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: Array<{ path: string; message: string }>;
    details?: Record<string, number | string | boolean>;
  };
};

/** Zod's issue list is safe to return: it describes the caller's own input. */
function fromZod(error: ZodError): ValidationError {
  return new ValidationError(
    "Some fields need attention.",
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

function normalise(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) return fromZod(error);

  const mongo = fromMongoError(error);
  if (mongo) return mongo;

  const fastify = error as Partial<FastifyError>;

  // Fastify's own schema validation, when a route declares one.
  if (fastify.validation) {
    return new ValidationError(
      "Some fields need attention.",
      fastify.validation.map((issue) => ({
        path: String(issue.instancePath || issue.params?.["missingProperty"] || ""),
        message: issue.message ?? "Invalid value",
      })),
    );
  }

  // Framework-level rejections — oversized bodies, bad content types, malformed
  // JSON — arrive with their own 4xx. Letting them fall through to 500 would
  // report the caller's mistake as our outage, and page somebody for a large
  // upload.
  const status = fastify.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    switch (status) {
      case 401:
        return new AuthenticationError();
      case 403:
        return new AuthorizationError();
      case 404:
        return new NotFoundError();
      case 409:
        return new ConflictError();
      case 413:
        return new PayloadTooLargeError();
      case 415:
        return new UnsupportedMediaTypeError();
      case 422:
        return new UnprocessableError();
      case 429:
        return new RateLimitError();
      default:
        return new ValidationError("The request could not be processed.");
    }
  }

  return new UnknownError();
}

/**
 * Anything we did not anticipate.
 *
 * The message is fixed and generic on purpose: an unhandled error's own
 * message is the one most likely to contain a connection string, a file path
 * or a query.
 */
class UnknownError extends AppError {
  readonly statusCode = 500;
  readonly code = "INTERNAL" as const;
  constructor() {
    super("Something went wrong on our end.");
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const normalised = normalise(error);
    const requestId = request.id;

    const logPayload = {
      err: error,
      requestId,
      route: request.routeOptions?.url ?? request.url,
      method: request.method,
      statusCode: normalised.statusCode,
      errorCode: normalised.code,
      ...(normalised.context ? { context: normalised.context } : {}),
    };

    // 5xx is ours to fix and gets a stack. 4xx is the caller's and would
    // otherwise drown the logs at the first sign of a bad client.
    if (normalised.statusCode >= 500) {
      request.log.error(logPayload, normalised.message);
    } else {
      request.log.warn(logPayload, normalised.message);
    }

    const body: ErrorBody = {
      error: {
        code: normalised.code,
        message: normalised.message,
        requestId,
      },
    };

    if (normalised instanceof ValidationError && normalised.fields) {
      body.error.fields = normalised.fields;
    }
    if (normalised instanceof BusinessRuleError && normalised.details) {
      body.error.details = normalised.details;
    }

    reply.code(normalised.statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        // Echoes the method and path only — both came from the caller.
        message: `No route for ${request.method} ${request.url}`,
        requestId: request.id,
      },
    } satisfies ErrorBody);
  });

  // A throw inside a plugin or hook during boot must not leave a half-started
  // process accepting traffic.
  if (!env.isTest) {
    process.on("unhandledRejection", (reason) => {
      app.log.fatal({ err: reason }, "unhandled rejection");
    });
  }
}
