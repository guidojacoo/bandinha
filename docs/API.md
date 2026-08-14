# API

Base URL: your `apps/web` deployment (e.g. `https://h59.health` or
`http://localhost:3000` in dev). All routes live under `src/app/api/**` as
Next.js Route Handlers.

## Auth

One signed JWT (`jose`, HS256, `AUTH_SECRET`) backs both surfaces:

- **Web**: stored as an `httpOnly` cookie (`h59_session`), set automatically
  by `POST /api/auth/login` / `POST /api/auth/register`.
- **Mobile**: the same endpoints also return `{ token }` in the JSON body;
  the app stores it in `expo-secure-store` and sends `Authorization: Bearer
  <token>` on every request.

Every route below except `/api/auth/*` requires one of the two. Missing or
invalid credentials → `401 { "error": "Unauthorized" }`. Every query is
additionally scoped to `session.userId` server-side — there is no way to
pass another user's ID and get their data back (see `docs/SECURITY.md`).

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{ email, password, name?, timezone? }` | Creates the account, returns `{ user, token }`, sets the cookie. |
| POST | `/api/auth/login` | `{ email, password }` | Same response shape. Identical error for wrong password / unknown email — doesn't leak which. |
| POST | `/api/auth/logout` | — | Clears the cookie. (Mobile just discards its stored token; no server call required.) |
| GET | `/api/me` | — | `{ user }` |

## Devices

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/devices` | — | `{ devices }` |
| POST | `/api/devices` | `{ bleId, name, firmwareVersion?, hardwareVersion?, capabilities?, hasVibrationMotor? }` | Upsert by `(userId, bleId)`. Called once right after a successful BLE pairing handshake. |
| GET | `/api/devices/:id` | — | `{ device }` |
| PATCH | `/api/devices/:id` | `{ name? }` | |
| DELETE | `/api/devices/:id` | — | Cascades health samples / sleep sessions / alarms for that device. |
| POST | `/api/devices/sync` | see below | The incremental sync endpoint — see `docs/ARCHITECTURE.md` "Sync design". |

### `POST /api/devices/sync`

```jsonc
{
  "deviceId": "…",                         // backend Device.id, not the raw BLE id
  "battery": { "level": 82, "charging": false },   // optional
  "healthSamples": [
    { "ts": "2026-08-14T06:05:00.000Z", "metric": "heart_rate", "value": 58, "unit": "bpm", "source": "device_history" }
  ],
  "sleepSessions": [
    {
      "date": "2026-08-14",
      "startTs": "2026-08-13T22:41:00.000Z",
      "endTs": "2026-08-14T07:08:00.000Z",
      "totalMinutes": 507,
      "source": "device_history",
      "stages": [{ "stage": "light", "startTs": "…", "durationMin": 90 }]
    }
  ]
}
```

`metric` ∈ `heart_rate | spo2 | blood_pressure | stress | hrv | steps |
distance | calories | battery`. `source` ∈ `device_realtime |
device_history | calculated | estimated` — see `packages/shared`'s
`DataSource` doc comment for what each means; the UI never labels a
`calculated`/`estimated` value as a device reading.

Response: `{ ok, deviceLastSyncAt, upserted: { healthSamples, sleepSessions }, sleepScores: { "2026-08-14": 87 } }`.
Sleep Scores are always computed server-side from the synced stages —
the client cannot set one directly.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health?from=&to=&deviceId=&limit=` | All metrics in range, newest first. |
| GET | `/api/health/heart-rate` (also `hrv`, `spo2`, `blood-pressure`, `stress`, `steps`, `distance`, `calories`, `battery`) | Same query params, one metric. |

## Sleep

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sleep?from=&to=` | Sessions (no per-stage detail), newest first. |
| GET | `/api/sleep/:date` | One session with full stage timeline. `date` = `YYYY-MM-DD`. |

## Recovery

| Method | Path | Notes |
|---|---|---|
| GET | `/api/recovery?date=` | Defaults to today. `{ available: false, reason }` if no sleep session exists for that date yet, otherwise `{ available: true, recovery }`. Cached in the DB after first computation for that date. |

## Alarms

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/alarms` | — | |
| POST | `/api/alarms` | `{ label, time, days, enabled?, vibration?, deviceId?, windowEndTime? }` | `time`/`windowEndTime` = `"HH:MM"`, `days` = `0`(Sun)`-6`(Sat). Always created with `nativeDeviceAlarm: false` — see `docs/BLE_PROTOCOL.md`. |
| PUT | `/api/alarms/:id` | any subset of the above | |
| DELETE | `/api/alarms/:id` | — | |

## Account

| Method | Path | Notes |
|---|---|---|
| GET | `/api/account/export` | Full JSON dump of everything the account owns (downloads as an attachment). |
| POST | `/api/account/delete` | Permanently deletes the user and everything that cascades from it. Clears the session cookie. |

## Errors

Every error response is `{ "error": "human-readable message" }` with an
appropriate status code (400 validation, 401 auth, 404 not found, 409
conflict, 500 unexpected). Request bodies are validated with `zod`
(`apps/web/src/app/api/**/route.ts`) before touching the database.
