# Deploying GoSaath

Written for the stack this is actually going onto: a single VPS running
CloudPanel, with PM2 keeping the Node process up and nginx terminating TLS in
front of it. No Docker, no orchestrator — one institution's pilot does not need
either, and every extra moving part is one more thing to be down at 8 a.m. on a
Monday.

Nothing here has been run against a real VPS yet. It is the configuration the
code expects, and the steps in order.

---

## 1. What runs where

```
  phone / admin browser
          │  HTTPS
          ▼
  nginx  (api.gosaath.sarmads.tech, gosaath.sarmads.tech)
          │  HTTP, 127.0.0.1:4000
          ▼
  gosaath-api  (PM2, fork mode, one instance)
          │
          ├──▶ MongoDB Atlas          commutes, rides, members, audit
          ├──▶ Cloudinary             profile photos
          ├──▶ Cloudflare R2          verification documents
          ├──▶ Resend                 OTP and decision emails
          └──▶ Expo push              notifications
```

Two names, one server:

| Name | Serves |
|---|---|
| `api.gosaath.sarmads.tech` | the API, proxied to the Node process |
| `gosaath.sarmads.tech` | the admin panel — static files from `gosaath-admin/dist` |

The mobile app talks only to the first. The admin panel is a static build; it
needs no Node process of its own.

### One instance, on purpose

`ecosystem.config.cjs` runs **one** process in fork mode, not a cluster. The
realtime hub keeps its subscribers in a Map inside the process, so a second
instance would have its own Map and would not see the first one's events —
roughly half of all connected clients would stop receiving updates, silently.

Clustering needs a shared backplane first. The seam is `publish()` in
`src/modules/realtime/hub.ts` and nothing else; Redis pub/sub or a MongoDB
change stream slots in behind it without touching a caller or a client.

The scheduler is already safe for multiple processes: `runSchedulerLocked`
takes a MongoDB lease, so overlapping passes are skipped rather than
duplicated. That was built first precisely so this decision stays reversible.

---

## 2. DNS

Two records to add wherever `sarmads.tech` is hosted (Get.tech, per the Resend
setup). `VPS_IP` is the server's public address.

| Type | Name | Value | Notes |
|---|---|---|---|
| A | `api.gosaath` | `VPS_IP` | the API |
| A | `gosaath` | `VPS_IP` | the admin panel |

Add `AAAA` records with the IPv6 address as well if the VPS has one.

**The Resend records already on `gosaath.sarmads.tech` are unaffected.** They
are `MX` and `TXT` on that name and on `send.gosaath.sarmads.tech`; an `A`
record is a different type and the two coexist. Adding the `A` record does not
change where mail is delivered.

Verify before pointing anything at it:

```bash
dig +short api.gosaath.sarmads.tech
dig +short gosaath.sarmads.tech
```

Certificates come after DNS resolves, not before — Let's Encrypt validates over
HTTP against the name, so a certificate requested too early fails and counts
against the rate limit.

---

## 3. Environment

Copy `.env.example` to `.env` on the server and fill it in. It is never
committed, and `env.ts` refuses to boot in production without the things that
matter — an empty `JWT_SECRET`, the console email provider, local disk storage
and a missing `CORS_ORIGINS` are each a startup failure rather than a
discovery in week two.

Generate the secret on the server, not locally:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Values that differ from development:

```ini
NODE_ENV=production
PORT=4000
HOST=127.0.0.1                 # nginx reaches it; the internet does not
PUBLIC_URL=https://api.gosaath.sarmads.tech
ADMIN_PANEL_URL=https://gosaath.sarmads.tech
CORS_ORIGINS=https://gosaath.sarmads.tech

TZ=Asia/Karachi                # every recurring schedule is read in this zone

EMAIL_PROVIDER=resend
EMAIL_FROM=GoSaath <no-reply@gosaath.sarmads.tech>

MEDIA_PROVIDER=cloudinary      # photos
UPLOADS_PROVIDER=s3            # verification documents, on R2
```

`HOST=127.0.0.1` matters: bound to `0.0.0.0` the Node process is reachable on
port 4000 directly, which bypasses nginx, TLS, and the rate limits keyed on the
real client address.

---

## 4. First deploy

```bash
# On the server, as the site user rather than root.
git clone https://github.com/sarmadcodes/gosaath-backend.git
cd gosaath-backend

npm ci                      # ci, not install: builds exactly the lockfile
cp .env.example .env        # then fill it in
npm run build               # tsc to dist/
npm run db:indexes          # creates every index before traffic arrives

mkdir -p var/log
pm2 start ecosystem.config.cjs
pm2 save                    # survives a reboot
pm2 startup                 # once per server; prints a command to run as root
```

`npm run db:indexes` is not optional and is not implicit. Mongoose would build
them lazily on first use, which means the first query of each kind is a
collection scan under real load.

### The first administrator

Every other admin arrives by invitation from a platform admin, which leaves an
obvious hole: the first one has nobody to invite them. `seed-admin` fills it in
development and refuses to run in production, so on a real deployment this is
the only way into the console:

```bash
npm run db:bootstrap -- gosaathapp@gmail.com "Sarmad Abbasi"
```

It **refuses if a platform administrator already exists**, and that is the
point: a bootstrap that could be re-run would grant platform access to any
address, with a shell on the box being the only thing in the way. Adding
administrators after the first is the console's own job, where the action is
recorded against whoever took it.

No password is set. Admin sign-in is by emailed code, so a password would be an
unused second way in — and an unused credential is one nobody rotates.

Then confirm it is actually up before putting nginx in front:

```bash
curl -s localhost:4000/health/ready | jq
pm2 logs gosaath-api --lines 50
```

### nginx

`deploy/nginx.conf.example` is the vhost. The part that is easy to miss is the
event stream: nginx buffers proxied responses by default, so without the
`proxy_buffering off` block the app gets **no live updates at all** and reports
no error anywhere — it simply looks like the feature was never built.

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### MongoDB Atlas

Add the VPS's public IP to the cluster's access list. Atlas refuses connections
from anywhere else, and the failure looks like a TLS error rather than a
permission one, which is a confusing afternoon if you have not seen it before.

---

## 5. The admin panel

A static build, served by nginx directly:

```bash
cd gosaath-admin
VITE_API_URL=https://api.gosaath.sarmads.tech npm run build
# then point the gosaath.sarmads.tech vhost document root at dist/
```

It is a single-page app, so the vhost needs the usual fallback or a refresh on
any route but `/` returns 404:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

`VITE_API_URL` is compiled in at build time, not read at runtime. Building with
the wrong value produces a panel that quietly talks to localhost.

---

## 6. Updating

```bash
cd gosaath-backend
git pull
npm ci
npm run build
npm run db:indexes          # no-op unless something was added
pm2 reload gosaath-api
```

`pm2 reload` sends SIGTERM and waits. Shutdown hangs up the event streams
first — they are in-flight requests that never finish on their own, so without
that the reload would wait out the timeout and then be killed mid-write.
`kill_timeout` is 15s to leave room for it.

Clients treat the hang-up as an ordinary disconnect and reconnect with
`Last-Event-ID`; the new process has a fresh sequence, so it answers `resync`
and every open screen refetches. A deploy therefore costs one refetch per
connected client, not a stale UI.

---

## 7. What to watch

```bash
pm2 logs gosaath-api           # pino JSON on stdout
pm2 monit                      # memory and restarts
curl -s https://api.gosaath.sarmads.tech/health/ready | jq
```

Logs are structured JSON and redact by configuration — passwords, OTPs, tokens
and push tokens never reach them. `src/utils/logger.ts` holds that list; add to
it when adding a field that should not be readable in a log.

Worth an eye in the first week:

- `push delivery given up on` — a notification nobody received. The in-app
  notification is still there; the nudge was not delivered after five attempts.
- `scheduler pass failed` — rides may not have been generated. The next pass
  retries; two in a row is worth investigating.
- `/health/ready` returning 503 — MongoDB is unreachable. The process stays up
  deliberately, so it recovers on its own when Atlas comes back.

---

## 8. Not done yet

Honest list, so none of it is discovered during the pilot:

- **Never deployed.** Every step above is untested against a real server.
- **No backups configured.** Atlas has its own snapshots on paid tiers; on the
  free tier there are none, and a dropped collection is gone.
- **No error tracking.** Failures are in the logs and nowhere else, so nobody
  learns about one unless they look.
- **No uptime monitoring.** Nothing polls `/health/ready` from outside.
- **One process, one server.** No redundancy. A reboot is an outage.

None of these blocks a controlled pilot with one institution. All of them block
calling the system generally available.
