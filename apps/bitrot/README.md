# Bitrot

**Dependency lifecycle risk, scored from live npm and PyPI registry data.**

Your CVE scanner answers "is there a published vulnerability in this version?"
Bitrot answers the other half: *is anyone still maintaining this?* Paste a
`package.json`, `package-lock.json` or `requirements.txt` and get a ranked list
of the dependencies that are deprecated, abandoned, or one maintainer away from
unmaintained.

## Why

- **48.5%** of production dependencies carry lifecycle risk that SCA tools do
  not surface (2026 analysis, ~16,000 packages across ~100 organisations).
- **20%+** of the top 50,000 npm packages are deprecated; roughly **2.1 billion**
  deprecated packages are downloaded from npm weekly.
- **Snyk Advisor shut down in January 2026** — the free "paste a package name,
  is it healthy?" check most developers reached for. The workflow it served did
  not move anywhere in particular.

Bitrot rebuilds that single-package check (no account needed) and then does the
thing Advisor never did: runs it across a whole manifest and ranks the results.

The scoring model, its calibration, and its known limits are in
[`docs/ROT_SCORE.md`](docs/ROT_SCORE.md). The HTTP surface is in
[`docs/API.md`](docs/API.md).

## Try it in five minutes

Everything below was run end-to-end on a clean checkout. Commands are from the
**repository root** unless stated otherwise.

### 1. Install

```bash
npm install
```

### 2. Start Postgres and create the database

Any Postgres 14+ works. Locally:

```bash
createdb bitrot
# or: psql -c "CREATE DATABASE bitrot;"
```

Hosted (Neon, Supabase, Vercel Postgres) works the same — just take the
connection string.

### 3. Configure

```bash
cp apps/bitrot/.env.example apps/bitrot/.env
```

Edit `apps/bitrot/.env`:

```ini
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/bitrot?schema=public"
SESSION_SECRET="<at least 32 characters>"   # openssl rand -base64 32
```

`SESSION_SECRET` signs session cookies. In development a built-in fallback is
used if it is unset; **in production the app refuses to start without it**, so a
missing env var can never silently sign sessions with a public value.

### 4. Migrate and seed

```bash
npm run migrate:deploy --workspace apps/bitrot
npm run seed --workspace apps/bitrot
```

The seed is not fixture data — it resolves real packages against the live
registries, so the scores it stores are whatever npm and PyPI say today. It
prints the demo credentials it created:

```
✓ demo user: demo@bitrot.dev / bitrot-demo-account
  resolving 10 packages for legacy-service/package.json… rot 66 (D)
  resolving 6 packages for legacy-service/requirements.txt… rot 46 (C)
```

### 5. Run it

```bash
npm run dev --workspace apps/bitrot
```

Open **http://localhost:3001**.

> Port 3001, so it does not collide with the H59 app in `apps/web` on 3000.

## What to click

1. **`/` — the landing page.** The "Try it on something real" box hits the live
   registry with no account. Try `request` (deprecated), `colors` (single
   maintainer, untouched since 2022), `express` (healthy).
2. **`/check`** — the same lookup, standalone. Switch to PyPI and try `nose`.
3. **Sign in** with `demo@bitrot.dev` / `bitrot-demo-account`.
4. **`/dashboard`** — the two seeded scans with their portfolio scores.
5. **Open a scan.** Findings are ranked worst-first. Click any row to expand the
   full signal breakdown — every number is explained in plain language.
6. **Acknowledge a finding** ("accepted risk"). The portfolio score recomputes
   immediately without a re-scan; the package stays visible, greyed out.
7. **`/scan`** — paste your own manifest, or click a sample. Upload works too.

## Verifying it actually works

```bash
# 101 unit tests: scoring, signals, manifest parsing, registry normalisers.
# No network, no database.
npm test --workspace apps/bitrot

npm run typecheck --workspace apps/bitrot
npm run build --workspace apps/bitrot
```

Health probe, including database connectivity:

```bash
curl -s localhost:3001/api/health
# {"ok":true,"database":"up"}
```

One live lookup, no auth:

```bash
curl -s localhost:3001/api/package/npm/request | head -c 300
```

## Deploying

Built for Vercel + any hosted Postgres (Neon, Supabase, Vercel Postgres).

1. Import the repository into Vercel.
2. Set **Root Directory** to `apps/bitrot`. Vercel detects Next.js and installs
   from the workspace root automatically.
3. Set environment variables: `DATABASE_URL`, `SESSION_SECRET`.
4. Deploy, then apply migrations against the production database:
   ```bash
   DATABASE_URL="<production url>" npm run migrate:deploy --workspace apps/bitrot
   ```

Two details already handled that otherwise bite on a first deploy:

- The build script runs `prisma generate` before `next build`, so the client is
  never stale against Vercel's dependency cache.
- The schema declares `binaryTargets = ["native", "rhel-openssl-3.0.x"]`. Without
  the rhel target the build succeeds and then fails at runtime with *"Query
  engine library for current platform could not be found"*.

## How it is put together

```
src/
  lib/
    rot/          Scoring engine — pure, no I/O, fully unit-tested
      signals.ts    The eight signals, each independently testable
      score.ts      Composition, grade bands, portfolio roll-up
    registry/     npm + PyPI clients; normalisers split from fetch so they
                  can be tested against recorded payloads
    parse/        package.json / package-lock.json / requirements.txt
    auth/         bcrypt hashing + JWT session cookies (jose)
    scanner.ts    Orchestration: parse → resolve → score → persist
    packageService.ts  Registry reads through the shared Postgres cache
  app/            Next.js App Router — pages and API routes
  components/     React components
prisma/           Schema, migration, and the real-data seed
docs/             Scoring model and API reference
test/             101 unit tests
```

**Design choices worth knowing:**

- **The scoring engine is pure.** `scoreOne` takes registry metadata plus an
  injected `now` and returns a number. No clock, network, or database, so
  calibration is testable and deterministic.
- **Registry reads are cached in Postgres** (`package_records`, 6h TTL by
  default). A repeat scan of a 200-package lockfile costs no registry traffic.
  The cache holds only public metadata and is shared across users; everything
  user-owned is scoped by session `userId`.
- **Concurrency is bounded** at 10 in-flight registry requests, so a large
  lockfile finishes quickly without being a bad citizen of a free public API.
- **Failures are findings.** A dependency that cannot be resolved is recorded
  with its error rather than dropped — a package that vanished from the registry
  is a result, not a gap.

## Security posture

- Passwords: bcrypt, cost 12. Login compares against a dummy hash when the email
  is unknown, so response timing does not reveal which accounts exist, and both
  failure modes return an identical message.
- Sessions: HS256 JWT in an `httpOnly`, `sameSite=lax` cookie, `secure` in
  production, 30-day expiry.
- Every scan, finding and acknowledgement query is scoped by the server-resolved
  `userId`. A client-supplied id is never trusted, and another user's scan id
  returns 404 rather than 403 — verified for read *and* delete.
- Only deliberately-raised errors forward their message to the client; anything
  unexpected is logged server-side and returned as a generic 500.
- The unauthenticated lookup endpoint is rate-limited to 60 requests/minute per
  IP. That limiter is per-process, so on a multi-instance deploy the effective
  limit is per instance — enough to stop one client hammering the upstream
  registries, and the shared-store upgrade path is noted in the code.

## Known gaps

Stated plainly rather than buried:

- **Scans are synchronous.** A 200-dependency lockfile resolves in a few seconds
  against a warm cache, but a cold 200-package scan holds the request open. A
  job queue with progress reporting is the right next step.
- **No download counts.** `api.npmjs.org/downloads` would let the score weight
  blast radius — the single most valuable signal still missing.
- **No repository health** (archived, last commit, open issues). That needs the
  GitHub API and a token; the registry-only design keeps Bitrot unauthenticated.
- **Lockfiles are capped at 200 packages** per scan.
- **No email verification or password reset.**

The scoring model's own limits — importance weighting, "finished" software,
`latest ≠ best` — are in [`docs/ROT_SCORE.md`](docs/ROT_SCORE.md#known-limits).

## Data sources

Public registry metadata only, read live and unauthenticated:

- [`registry.npmjs.org`](https://registry.npmjs.org) — packument: version
  timeline, maintainers, deprecation flags, license, repository.
- [`pypi.org/pypi/<name>/json`](https://pypi.org) — release upload times, trove
  classifiers, yank status, license, project URLs.
