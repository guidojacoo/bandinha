# Setup

## Prerequisites

- Node.js 20+
- Python 3.11+ (only for `tools/ble-probe`)
- A Postgres database — local via Docker, or a free [Neon](https://neon.tech) / [Supabase](https://supabase.com) project for real use
- For the mobile app: an [Expo](https://expo.dev) account (free) + [EAS CLI](https://docs.expo.dev/eas/) if you want to build a real device install; a Mac is needed for iOS builds, Android works from any OS

## 1. Install everything

```bash
npm install
```

This installs all workspaces (`apps/*`, `packages/*`) at once — npm
workspaces, no extra tooling required.

## 2. Database

Local dev, via Docker:

```bash
docker run --name h59-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
```

Then:

```bash
cp packages/db/.env.example packages/db/.env
npm run db:generate
npm run db:migrate   # creates the schema; prompts for a migration name the first time
```

Optional seed data (creates `demo@h59.health` / `demo1234`):

```bash
npm run seed --workspace packages/db
```

## 3. Web dashboard + backend

```bash
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/web/.env.local`:
- `DATABASE_URL` — same value as `packages/db/.env`
- `AUTH_SECRET` — generate with `openssl rand -base64 32` (or any
  cryptographically random 32+ byte string)

```bash
npm run dev:web
```

Open http://localhost:3000 — register an account, and you'll land on an
empty dashboard prompting you to pair a device from the mobile app.

## 4. Mobile app

BLE requires a **custom dev client** — `npx expo start` alone (Expo Go)
cannot load `react-native-ble-plx`, which needs native code. One-time setup:

```bash
cd apps/mobile
npx eas login          # free Expo account
npx eas build --profile development --platform android   # or ios
```

This builds an installable dev-client APK/IPA (takes a few minutes on
Expo's build servers). Install it on your phone, then:

```bash
npm run dev:mobile      # from the repo root — starts the Metro bundler
```

Open the installed dev-client app on your phone and it will connect to
Metro automatically (scan the QR code the first time).

**Point the app at your backend**: `apps/mobile/app.json`'s
`expo.extra.apiBaseUrl` defaults to `http://localhost:3000`, which only
resolves on the same machine. Testing on a **real phone**, set it to your
dev machine's LAN IP instead (e.g. `http://192.168.1.23:3000` — find yours
with `ipconfig` / `ifconfig`), and make sure your phone is on the same
Wi-Fi network as the machine running `npm run dev:web`.

## 5. Connect a real H59

1. Register/sign in on the mobile app with the same account as the web dashboard.
2. Turn off Bluetooth on any other phone currently connected to the band
   (QWatch Pro or otherwise) — the H59 only talks to one device at a time.
3. Wear the band, go to the **Devices** tab → **Pair a new H59**, scan, tap
   it in the list.
4. The app connects, reads its real capabilities + battery, registers it
   with your account, and pulls history (first sync defaults to 7 days).
5. Everything then shows up on both the mobile app and the web dashboard.

## 6. Hardware research tool (optional, for the open protocol questions)

See [`tools/ble-probe/README.md`](../tools/ble-probe/README.md) — a
separate Python script (not part of the product) for testing whether the
band vibrates and for capturing the packets needed to find the alarm
command. Full step-by-step is in that file.

## 7. Running tests

```bash
npm test    # runs every workspace's test suite (packages/protocol, packages/scoring)
```

These run with zero external dependencies (no database, no hardware) —
safe to run in CI as-is.

## 8. Deploying to Vercel

```bash
npm i -g vercel
cd apps/web
vercel link
vercel env add DATABASE_URL production   # your Neon/Supabase connection string
vercel env add AUTH_SECRET production
vercel env add NEXTAUTH_URL production   # e.g. https://your-app.vercel.app
```

Then either `vercel --prod` from `apps/web`, or connect the GitHub repo in
the Vercel dashboard with **Root Directory** set to `apps/web` (needed
because this is a monorepo). Run the Prisma migration against the
production database once, from your machine, before the first deploy:

```bash
DATABASE_URL="<your production URL>" npm run db:migrate:deploy --workspace packages/db
```

Vercel never touches Bluetooth — see `docs/ARCHITECTURE.md`. It only ever
serves the API and the web dashboard; all device I/O happens on the phone
and reaches Vercel over normal HTTPS via the sync endpoint.

For the mobile app, a **production** build (as opposed to the development
client above) is `eas build --profile production` once you're ready to
distribute via TestFlight / Play Console / an internal APK — see the
[EAS Build docs](https://docs.expo.dev/build/introduction/) for store
submission specifics, which are account/store-specific and outside what
this repo can automate.
