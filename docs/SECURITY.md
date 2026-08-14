# Security & Privacy

## Authentication

- Passwords hashed with `bcryptjs` (cost factor 10), never stored or logged
  in plaintext. `apps/web/src/lib/password.ts`.
- Sessions are a signed JWT (`jose`, HS256, `AUTH_SECRET` env var — see
  `docs/SETUP.md` for generating one). No session state in the database;
  a stolen `AUTH_SECRET` is the actual blast radius to protect, not a
  sessions table.
- The same token is used as an `httpOnly`, `sameSite=lax`, `secure` (in
  production) cookie for the web dashboard, and as a bearer token stored in
  `expo-secure-store` (iOS Keychain / Android Keystore) for the mobile app.
  Neither surface can read the other's storage — the token itself is the
  only shared secret, and it's never written to plain `AsyncStorage`, logs,
  or a URL query string.
- Login returns an identical error for "no such account" and "wrong
  password" — this deliberately doesn't confirm whether an email is
  registered.

## Authorization: per-user data isolation

Every Prisma query in `apps/web/src/app/api/**` is scoped by `userId`
resolved server-side from the verified session token
(`apps/web/src/lib/session.ts`) — **never** from a client-supplied field.
Concretely:

- List endpoints (`/api/devices`, `/api/health`, `/api/sleep`, `/api/alarms`)
  always `WHERE userId = session.userId`.
- Single-resource endpoints (`/api/devices/:id`, `/api/alarms/:id`) do a
  `findFirst({ where: { id, userId } })` before any mutation — a valid ID
  belonging to another user resolves to `404`, not `403`, so existence
  itself isn't leaked.
- `POST /api/devices/sync` re-checks that `deviceId` belongs to
  `session.userId` before writing anything.
- Every table that stores user data (`HealthSample`, `SleepSession`,
  `SleepStageSegment`, `RecoveryScore`, `Alarm`, `AiInsight`) carries a
  `userId` (or a foreign key to a row that does) with `onDelete: Cascade`,
  so deleting an account (`POST /api/account/delete`) actually removes
  everything, not just the `User` row.

## Health data handling

- **Nothing is sent to a third party without explicit, per-action
  consent.** The one designed exception is an opt-in AI insights layer
  (`AiInsight` model) that is entirely unbuilt/unwired in this version —
  the schema exists so the feature has somewhere to land, but no code path
  populates it or calls any external AI service. When it is built, it must
  only run on user action, only send aggregated summaries (never raw
  samples), and be off by default — the same posture OpenH59's own AI
  analysis feature took.
- Server logs (`console.error` in API routes) log error objects, not
  request bodies — no health values or credentials are deliberately logged.
  Standard platform-level access logs (Vercel, Postgres) are outside this
  app's control; see your hosting provider's own data-handling policy.
- **Account deletion is real deletion**, not a soft-delete flag —
  `POST /api/account/delete` issues an actual `DELETE` cascading through
  every table above.
- **Data export** (`GET /api/account/export`) returns everything the
  account owns as one JSON file, satisfying data-portability requests
  without needing to ask a human.
- Blood pressure is explicitly never fabricated: the H59 has no real
  on-device BP history (see `docs/BLE_PROTOCOL.md`), and the product
  surfaces on-demand BP readings only, clearly sourced — it never
  synthesizes an hourly curve the way QWatch Pro's own app does.

## Transport

- Production is HTTPS-only via Vercel's default TLS termination.
  `secure: true` is set on the session cookie whenever `NODE_ENV ===
  "production"`.
- BLE traffic between the phone and the band is whatever security the H59's
  firmware itself provides (this protocol family does not appear to use BLE
  pairing/bonding or characteristic encryption — same as OpenH59 and
  Gadgetbridge found). That's a hardware/firmware property, not something
  this app can add on top of.

## Input validation

Every API route validates its request body with `zod` before it reaches
Prisma — see `apps/web/src/app/api/**/route.ts`. Malformed input is
rejected with `400` and a specific message, not passed through.

## Known gaps (be honest about these)

- **No rate limiting** on auth endpoints in this version — add one
  (Vercel's edge middleware, or a service like Upstash) before real-world
  deployment if brute-force login attempts are a concern.
- **No email verification / password reset flow** — `AUTH_SECRET` rotation
  and manual DB intervention are the only recovery paths today.
- **No audit log** of who accessed what, beyond normal hosting-provider logs.
- These are reasonable v1 gaps for a personal/self-hosted health app, not
  oversights hidden from you — track them before exposing this to
  strangers on the public internet.
