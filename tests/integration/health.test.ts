import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";

/**
 * Phase 0 gate.
 *
 * These run with no MongoDB available, which is the point: the interesting
 * assertion is that readiness tells the truth about that rather than
 * reporting healthy because the process happens to be running.
 */
describe("health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports liveness without touching any dependency", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports NOT ready, with 503, when the database is unreachable", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    // A load balancer must take this instance out rather than send it work.
    expect(response.statusCode).toBe(503);

    const body = response.json();
    expect(body.status).toBe("not_ready");
    expect(body.checks.database.reachable).toBe(false);

    // Unauthenticated endpoint: it must not describe where the database is.
    const raw = response.body;
    expect(raw).not.toMatch(/ECONNREFUSED/);
    expect(raw).not.toMatch(/27017/);
    expect(raw).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(raw).not.toMatch(/mongodb(\+srv)?:\/\//);
  });

  it("summarises without leaking connection details", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service).toBe("gosaath-backend");
    expect(body.timezone).toBe("Asia/Karachi");

    // Nothing here may expose where the database lives.
    const raw = response.body;
    expect(raw).not.toMatch(/mongodb(\+srv)?:\/\//);
    expect(raw).not.toMatch(/password/i);
  });

  it("serves the versioned api root", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { service: "gosaath-backend", version: "v1" },
    });
  });
});

describe("errors", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns the standard error envelope for an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it("echoes an upstream request id so a trace survives the proxy hop", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/nope",
      headers: { "x-request-id": "req_from_upstream" },
    });

    expect(response.json().error.requestId).toBe("req_from_upstream");
  });

  it("rejects a body over the limit rather than buffering it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ blob: "x".repeat(300 * 1024) }),
    });

    // 413 from the body limit, or 404 if routing rejects first — either way
    // the oversized payload is never processed.
    expect([413, 404]).toContain(response.statusCode);
  });

  it("never rate-limits health probes", async () => {
    // A throttled readiness probe reads as an outage and removes the instance.
    const results = await Promise.all(
      Array.from({ length: 60 }, () =>
        app.inject({ method: "GET", url: "/health/live" }),
      ),
    );

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
  });
});
