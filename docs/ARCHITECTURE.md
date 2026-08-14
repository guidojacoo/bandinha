# Architecture

## Why this shape

Bluetooth LE only works from the phone that's physically near the band —
Vercel (or any cloud host) has no Bluetooth radio. So the architecture is
split at exactly that boundary:

```
H59 band
   │  Bluetooth LE (Nordic UART + "bc" big-data channel)
   ▼
apps/mobile (Expo + react-native-ble-plx)
   │  decodes/encodes via packages/protocol
   ▼
local cache (expo-sqlite) ── works fully offline
   │  flushed opportunistically over HTTPS
   ▼
apps/web  (Next.js Route Handlers = the backend API)
   │
   ▼
PostgreSQL (Neon/Supabase in prod)
   ▲
   │  same API, browser instead of phone
apps/web (Next.js App Router = the web dashboard)
```

Nothing in `apps/web` ever talks to the band directly, and nothing in
`apps/mobile`'s BLE layer needs the internet to keep working — the two are
connected only by the sync endpoint (`POST /api/devices/sync`) and a local
outbox queue.

## Monorepo layout

```
apps/
  mobile/     Expo (dev client) + TypeScript + react-native-ble-plx
              — pairing, local cache, sync, and every screen
  web/        Next.js 15 App Router — ONE deploy is both:
              - the backend (src/app/api/**/route.ts)
              - the web dashboard (src/app/(app)/**/page.tsx)
packages/
  protocol/   Pure TS: H59/Colmi-QC BLE framing, commands, parsers.
              Zero BLE-library dependency — takes/returns bytes, so it's
              unit-tested (packages/protocol/test) without hardware and
              shared between apps/mobile and tools/ble-probe's Python side
              (re-implemented there since Python can't import TS, but kept
              byte-for-byte identical — see docs/BLE_PROTOCOL.md).
  scoring/    Sleep Score + Recovery Score — pure functions, see
              docs/SLEEP_ALGORITHM.md.
  db/         Prisma schema + generated client, shared by apps/web.
  shared/     Cross-cutting TS types (HealthMetric, DataSource, SleepStage,
              DeviceCapabilities, DTOs) so mobile/web/protocol don't drift
              into three different definitions of the same concept.
tools/
  ble-probe/  Standalone Python research tool (see docs/BLE_PROTOCOL.md) —
              not part of the product, used to test hardware-dependent
              unknowns (vibration, alarm discovery) against a real H59.
docs/         This folder.
```

## Why Next.js does double duty (backend + dashboard)

One Vercel deployment, one Postgres connection pool, one auth
implementation. Route Handlers under `src/app/api/**` are the REST API (see
`docs/API.md`); Server Components under `src/app/(app)/**` render the
dashboard and query Prisma directly (no self-fetching over HTTP) for
speed — the mobile app and any future API consumer go through the same
`src/app/api/**` routes the dashboard's client-side pieces also use.

## Auth: hand-rolled JWT, not NextAuth

The product needs one session mechanism that works identically as a
browser cookie (web) and a bearer token stored in `expo-secure-store`
(mobile). A cookie-first library fights that second requirement, so
`apps/web/src/lib/jwt.ts` signs/verifies a JWT with `jose` directly, and
`apps/web/src/lib/session.ts` accepts either an `Authorization: Bearer`
header or the `h59_session` cookie — same verification path either way. See
`docs/SECURITY.md`.

## Sync design

- Every device read lands in the phone's local SQLite cache first
  (`apps/mobile/src/storage/localDb.ts`) — the UI and the outbox both work
  offline.
- `packages/protocol`'s `resolveSyncPlan` decides how many days of on-device
  history to re-pull, mirroring OpenH59's own incremental-sync heuristic
  (daily sync → 0 extra days; away a few days → exactly that gap; away
  longer than the device's ~7-day buffer → capped at 14). Fully unit tested
  without hardware — see `packages/protocol/test/syncPlan.test.ts`.
- Uploads are idempotent: health samples use `createMany` +
  `skipDuplicates` against a `(deviceId, metric, ts)` unique constraint;
  sleep sessions upsert by `(deviceId, date)`. Re-syncing the same day twice
  — or syncing after being offline for a week — never creates duplicates.
- `flushPendingToBackend` can be called any time connectivity returns; it
  only uploads rows not yet marked `synced` in the local cache.

## What's deliberately NOT built into the architecture

- No server-side BLE anything, anywhere — see `docs/BLE_PROTOCOL.md` and
  the product brief's own constraint.
- No native device-alarm write path wired into the UI — the command is
  UNKNOWN (see `docs/BLE_PROTOCOL.md`); alarms use phone notifications
  today, which don't depend on any of this.
