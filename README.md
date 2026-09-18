# GoSaath Backend

Node + TypeScript + MongoDB backend for the GoSaath commute app, the future
University Admin panel and the Super Admin panel.

**Phase 0 complete.** The foundation runs: config, logging, error handling,
database pool, health, graceful shutdown, and the vendored API contract.
No domain endpoints yet — see [Build order](#build-order).

## Quick start

```bash
npm install
cp .env.example .env     # fill in MONGODB_URI
npm run dev              # http://localhost:4000
```

No MongoDB yet? It still starts. `/health/ready` returns **503** until a
database is reachable, which is the intended behaviour, not a failure.

| Command | Does |
|---|---|
| `npm run dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run verify` | contract + typecheck + tests + build — **the phase gate** |
| `npm run contract:check` | Fail if the vendored contract drifted from the app |
| `npm run contract:sync` | Re-copy the contract from the app |
| `npm run check:shutdown` | SIGTERM path (**Linux/macOS only** — see below) |

## Architecture

```
HTTP
 → rate limit            per IP; per account on auth routes later
 → validation            Zod; unknown keys rejected
 → authenticate          JWT: signature, exp, iss, aud, type, session state
 → authorize             role gate
 → scope                 AdminScope from the session, never the request
 → controller            HTTP only: parse, delegate, shape
 → service               business rules, transactions, invariants
 → repository            Mongo access, projections, indexes
 → MongoDB
```

```
src/
  app/          server (boot, shutdown) and app (routes, plugins)
  config/       validated environment
  contract/     VENDORED from the mobile app — never edit by hand
  db/           connection pool, health
  middleware/   error handler; auth and scope land in later phases
  modules/      one folder per domain area
  utils/        errors, logger
scripts/        contract sync/check
tests/
  integration/  driven through app.inject()
  manual/       needs a real process (shutdown)
```

### The contract is vendored, not re-declared

`src/contract/` is a copy of the mobile app's `types.ts`, `api.ts` and
`roles.ts`. `npm run contract:check` fails when they drift.

Re-typing those types here by hand is how a field quietly becomes optional on
one side and required on the other, with nothing catching it until a screen
renders blank. The client is the source of truth for shapes; this repo serves
them.

### Error handling

Every error becomes one typed `AppError` and one envelope:

```json
{ "error": { "code": "NOT_FOUND", "message": "…", "requestId": "req_…" } }
```

A driver error never reaches a client. `E11000 duplicate key index:
users.email_1` names the collection, the index, and confirms the address
exists — it becomes a 409 "That already exists."

Framework rejections (413, 415, malformed JSON) map to their real 4xx rather
than falling through to 500, so a caller's mistake is never reported as our
outage.

### Logging

Structured JSON via Pino, with a request id on every line. `LOG_PRETTY=true`
for local reading.

Redaction is deliberately **narrow**. Secrets are wildcarded (`*.password`,
`*.otp`, `*.refreshToken`); `code` and `token` are not. `code` is
overwhelmingly a Mongo or HTTP error code, and wildcarding it turns every
database failure into `[redacted]` — blind exactly when the log matters most.
The OTP and any bearer token only arrive from the client, so `req.body.code`
and `req.body.token` cover the real exposure.

### Health

| Endpoint | Meaning | On failure |
|---|---|---|
| `/health/live` | Process alive. No dependencies touched | Restart the instance |
| `/health/ready` | Can serve traffic. Pings Mongo | **503** — take out of the pool, do not restart |
| `/health` | Human summary | — |

Separated on purpose: one endpoint for both means a brief database blip
restarts every instance at once.

`/health/ready` reports the database as unreachable **without naming it**. The
endpoint is unauthenticated, so echoing `ECONNREFUSED 127.0.0.1:27017` would
let a probe map internal infrastructure. The detail is logged, not served.

### Time

`arriveBy` / `leaveCampusAt` are local wall-clock strings (`"08:00"`), never
timestamps. `TZ` is pinned to `Asia/Karachi` in config and the host's zone is
never consulted — a container running UTC would otherwise shift everyone's
commute by five hours.

## Security posture (Phase 0)

- Secrets only from env; `JWT_SECRET` and `CORS_ORIGINS` are **required**
  outside development and the process refuses to boot without them
- CORS is an explicit allowlist, never `*`. Requests with no `Origin` (the
  mobile app) are allowed; browsers must be on the list
- Helmet, with HSTS in production
- Body limit 256 KB by default; request timeout 20 s
- `trustProxy` only where a proxy actually terminates TLS — trusting it
  everywhere lets a client forge `X-Forwarded-For` and defeat rate limits
- Health checks are exempt from rate limiting: a throttled readiness probe
  reads as an outage and removes the instance

## Known gaps

1. **Graceful shutdown is UNVERIFIED.** Implemented to the standard pattern —
   stop accepting, drain in-flight, close Mongo, 15 s guard — but Windows has
   no POSIX signals and maps SIGTERM to `TerminateProcess`, so the handler
   never runs here. `npm run check:shutdown` skips on Windows by design and
   must be run on Linux before deploying.
2. **2 moderate npm advisories**, both in `@vitest/mocker` → dev-only, never
   shipped. The offered fix downgrades vitest and reintroduces the esbuild
   advisories, so it is deliberately not applied.
3. **No MongoDB configured locally.** Everything past Phase 1 needs one —
   Atlas free tier or Docker.

## Build order

Each phase ends with `npm run verify` passing.

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | **Foundation** | **Done** |
| 1 | Models, indexes, seed (areas, SZABIST, Clifton) | Indexes asserted in a test |
| 2 | Auth: register, OTP, verify, login, restore, reset | Brute-force tests |
| 3 | me, institutions, campuses, areas, preferences, vehicles | Mass-assignment tests |
| 4 | Commutes, RideInstance generation, attendance, exceptions | Job twice → one row |
| 5 | Matching, search, nearby, blocks both directions | `explain()` shows IXSCAN |
| 6 | Seat requests, accept/decline | 10 concurrent vs 2 seats |
| 7 | Notifications, push tokens, delivery job | Delivery never blocks response |
| 8 | Safety, reports, support | |
| 9 | Audit log + scope middleware — **before any admin route** | Member cannot read audit |
| 10 | University Admin | IDOR suite |
| 11 | Super Admin, activation checklist | Privilege-escalation suite |
| 12 | SSE | Scoped events |
| 13 | Performance: load, p95/p99, query plans | |
| 14 | Security review, then `httpApi` integration | App runs against real backend |

Phases 0–6 are the product. After those, SZABIST works end to end.

## Reference

- [`../GoSaath/SYSTEM.md`](../GoSaath/SYSTEM.md) — product rules and domain model
- [`../GoSaath/docs/BACKEND-AUDIT.md`](../GoSaath/docs/BACKEND-AUDIT.md) — contract audit, resolved conflicts, index plan
- [`../GoSaath/docs/ADMIN.md`](../GoSaath/docs/ADMIN.md) — admin panel spec
