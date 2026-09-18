# GoSaath Backend

Node + TypeScript + MongoDB backend for the GoSaath commute app, the future
University Admin panel and the Super Admin panel.

**Phases 0–1 complete, plus the email service.** Foundation, the full data
layer (17 collections, every index, idempotent seed), and provider-agnostic
email ready for Phase 2's OTP flow. No HTTP endpoints for the domain yet —
see [Build order](#build-order).

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
| `npm run db:indexes` | Create every declared index. **A deploy step** |
| `npm run db:seed` | Areas, SZABIST, Clifton, configuration. Idempotent |

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

### Data layer

`autoIndex` and `autoCreate` are **off**. Indexes are built by
`npm run db:indexes` as an explicit deploy step — leaving it on means every
process races to build them at boot, and a production deploy silently blocks
on a foreground build.

Three collections stay strictly separate: **Commute** (recurring template, no
dates) → **RideInstance** (one calendar date) → **Attendance** (one person on
one instance). Collapsing them makes "I can't drive this Thursday"
inexpressible without editing the template, which silently changes every other
week too.

Unique indexes are correctness, not tuning:

| Index | Guarantees |
|---|---|
| `users.email` | One account per address, case-insensitive |
| `rideInstances {commuteId, date}` | Generation is idempotent across racing workers |
| `attendance {rideInstanceId, userId}` | No double seat from a retried request |
| `seatRequests {rideInstanceId, requesterId}` | One outstanding request per ride |
| `blocks {blockerId, blockedId}` | No duplicate block rows |
| `campuses {institutionId, name}` | No two "Main Campus" rows |

Seats live on the **RideInstance**, not the Commute: a driver with a full car
on Monday may have space on Wednesday.

### Area centroids

Areas carry a centroid; users never do. That is public geography about a
neighbourhood — roughly where Gulshan-e-Iqbal sits — and is categorically
different from storing where a person is. It exists for one job: deciding
whether two areas are within `NEARBY_RADIUS_KM`. It is never serialised to a
client, and a test asserts the user schema has no coordinate field.

Distance is Haversine, not routed. A routing API would be more accurate and
would also cost a network call per candidate on the matching hot path; at a
three-kilometre threshold both rank neighbourhoods the same way.

### Email

Domain code depends on `EmailService` and asks for "send a verification code",
never "POST to Resend". Every message the product sends is enumerated on that
interface, so no route can compose arbitrary email out of user input, and no
service holds an API key.

| Provider | When |
|---|---|
| `console` | Development. Prints the message; **rejected outside development** |
| `resend` | Real delivery |

`console` is refused in staging and production by config validation, because a
deployment that silently swallows every verification email is indistinguishable
from one where nobody can sign up.

Resend is called over plain `fetch`, not the SDK. Sending is one authenticated
POST, and the official client does not expose a per-request timeout — the one
control that matters, since a hung provider would otherwise hold a registration
open until the server's 20s ceiling. `AbortController` gives an exact bound and
drops a dependency from the path of every account created.

- Retries only 408/429/5xx, three attempts, exponential backoff. A 401 from a
  bad key fails identically every time, so it is raised immediately rather than
  retried three times and buried
- An `Idempotency-Key` derived from the payload means a retry after a lost
  response cannot deliver two codes
- Codes never appear in a subject line: subjects render on a lock screen
- Names and admin-written reasons are HTML-escaped

To switch on real delivery: verify a domain in Resend, then set
`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and an `EMAIL_FROM` on that domain.

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
3. **The Atlas credential was pasted into a chat.** It works, and it is in
   `.env` which is gitignored — but it should be rotated in Atlas before this
   goes anywhere real, and the production credential should never be typed
   into a chat window at all.
4. **Tests run against a separate `gosaath_test` database**, forced in
   `vitest.config.ts` rather than read from `.env`, so no run can touch real
   data even if the environment says otherwise.

## Build order

Each phase ends with `npm run verify` passing.

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | **Foundation** | **Done** |
| **1** | **Models, indexes, seed** | **Done** — 29 tests |
| 2 | Auth: register, OTP, verify, login, restore, reset | Brute-force tests |
| — | *Email service (done early — Phase 2 needs it)* | 17 tests |
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
