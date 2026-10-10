# Rainmaker

**An autonomous B2B sales agent. Give it one URL.**

It reads the website of the thing you sell, works out who buys it, goes and
finds those companies, writes to each one about something true it found on
their own site, reads the replies, handles the objections, and works the
pipeline — on a loop, without being asked again.

```bash
npm run sell -- https://your-company.com
```

That is the whole interface. Everything below is either how to run it or why
it makes the decisions it does.

---

## What it actually does

| Stage | What happens |
|---|---|
| **Ingest** | Crawls your site the way a person would — home, pricing, product, customers, about — and extracts what you sell, what you can *prove*, your pricing model and your tone of voice. |
| **Profile** | Derives an ICP: industries, headcount band, the job titles that hold budget, and the words a company with this problem has on its own public website. |
| **Prospect** | Finds candidate companies through pluggable sources: a seed list, directory/listing pages, or a search backend. |
| **Qualify** | Crawls each candidate, extracts firmographics, technology, published contacts and **evidence** — the actual sentences on their site that show the pain — then scores fit on seven weighted signals. |
| **Compose** | Writes the message. The opening line must reference real evidence; every claim about *you* must trace back to your own pages. |
| **Send** | Through a compliance gate that no code path bypasses. |
| **Converse** | Classifies each reply (interest, pricing, objection, referral, not-now, opt-out, bounce), answers the winnable ones from an objection playbook, escalates the rest. |
| **Pipeline** | Pauses cadences on reply, books meetings, moves deal stages, and stops the moment someone asks it to. |

The orchestrator runs all of this as one bounded, resumable `tick()`. Called on
a timer, that is the agent.

---

## Run it in five minutes

Everything here was run end-to-end on a clean checkout.

### 1. Install and set up Postgres

```bash
npm install
createdb rainmaker                  # any Postgres 14+; hosted works too
cp .env.example .env                # then set DATABASE_URL and SESSION_SECRET
npm run migrate:deploy
```

### 2. See it work, start to finish

```bash
npm run fixtures &                  # a local "internet" of 10 company sites
sudo bash fixtures/hosts.sh         # maps *.test to 127.0.0.1
npm run demo
```

`npm run demo` runs the complete funnel against that local web, with simulated
buyers replying in character. Two things are simulated — the websites and the
people — and nothing else: the crawler, scorer, composer, compliance gate,
cadence engine, transports and classifier are the production ones.

Expect roughly this:

```
  day   found  qual  enrol   sent  blocked  replies  stops
  10-12     8      7      4      7        ·        4      1
  10-13     ·      ·      ·      2        ·        3      ·
  10-14     ·      ·      ·      1        ·        1      ·

  COMPANY                   FIT  BAND          STAGE
  Hoverboard Logistics       58  good          won
  Meridian Pay               58  good          meeting_booked
  Northgate Health           43  marginal      contacted        ← opted out, suppressed
  Lumen Grid                 43  marginal      engaged          ← "not now"
  Atlas Freight              35  marginal      —                ← below the fit bar
  Quietleaf                  26  poor          —
  Tiny Bakery                20  poor          —
  SLOScope                    0  disqualified  —                ← competitor
```

Read `./outbox/*.eml` to see exactly what would have been delivered.

### 3. Point it at something real

```bash
export DIRECTORY_URLS="https://some-industry-directory.example/members"
npm run sell -- https://your-company.com
```

It will research, qualify and draft. It will **not** transmit anything until a
sender identity exists and `SEND_MODE=live` with SMTP configured — see
[Going live](#going-live).

### 4. Leave it running

```bash
npm run agent -- --loop --interval 300
```

### 5. Watch it

```bash
npm run dev     # http://localhost:3000
```

Register, and the console shows the pipeline, every company with the evidence
behind its score, every message with how it was composed, replies with their
classification, anything held for your approval, and a full activity log.

---

## Verifying it

```bash
npm test          # 133 unit tests: scoring, cadence, compliance, classification,
                  # crawling, extraction. No network, no database, no model.
npm run typecheck
npm run build
curl -s localhost:3000/api/health
```

---

## Going live

Sending to real people needs **two** independent things, because credentials
alone are not consent:

1. `SEND_MODE=live` plus `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS`
2. A complete sender identity: name, address, and a **real postal address**

You supply the mailbox, and that is the point — you are the accountable sender
on every message, your domain's reputation is the one at stake, and your
SPF/DKIM/DMARC records are what make the mail arrive. There is no shared
Rainmaker sending infrastructure to hide behind.

Before the first live run: warm the domain, start at ten sends a day, and keep
`PER_DOMAIN_DAILY_CAP` at 1–2.

---

## The guardrails, and why they are not optional

Every outbound message passes `evaluateSend()` and nothing has a path around
it. In order of precedence:

1. **Sender identity** — incomplete, nothing sends at all.
2. **Never-contact addresses** — `abuse@`, `security@`, `privacy@`, `postmaster@`, `noreply@`.
3. **Suppression** — outranks everything, including caps and windows. Global per user: someone who opts out of one campaign is out of all of them, forever.
4. **Blocked domains**, including subdomains.
5. **Frequency** — a minimum gap between touches to one person.
6. **Volume** — a daily cap, and a much tighter per-recipient-domain cap.
7. **Timing** — business hours in the recipient's locale.

Replies are exempt from 5 and 6 and nothing else: a prospect who asks a
question at 10am should not be met with silence for 48 hours because of an
anti-spam throttle.

This is not squeamishness. Unsolicited bulk mail to harvested addresses is
unlawful under CAN-SPAM §7704, the GDPR and Argentina's Ley 25.326 — and, just
as fatally for the goal of selling anything, it burns the sending domain within
hours, after which even the wanted mail stops arriving. The compliant version
is the one that works.

### What it will not decide on its own

- **It never marks its own deals won.** A verbal yes moves a deal to
  `proposal`. `won` is set by a payment webhook, a contract callback, or a
  person — via `POST /api/deals/:id`. An agent allowed to declare its own wins
  produces a pipeline that measures its own optimism.
- **It holds a reply back** whenever it is not confident, when a thread has run
  past four agent turns, and whenever money or a signature is involved.
- **It never invents a fact about you.** Every claim in generated copy must be
  a substring of something extracted from your own site; a draft that fails
  that check is repaired once and then falls back to a template.

---

## Architecture

```
src/
  core/            Pure, IO-free, 133 unit tests. The part that must be provably right.
    fit.ts           Seven weighted signals → 0-100 + explanation
    compliance.ts    The send gate
    sequence.ts      Cadence state machine (pure reducer)
    classify.ts      Deterministic reply classification
    draft.ts         Anti-fabrication / anti-spam validation
    icp.ts           Heuristic ICP derivation (the no-API-key floor)
  infra/
    crawler/         Real HTTP, robots.txt, HTML → structured signals
    llm/             Anthropic client, structured output, graceful degradation
    sources/         Pluggable prospect discovery (seed / directory / search)
    transport/       Outbound (dry-run, SMTP) and inbound (maildir, IMAP)
  agent/
    ingest · qualify · compose · converse · deals
    orchestrator.ts  The autonomous tick loop
  app/               Next.js console + API
  cli/               sell · agent · demo
fixtures/            A local internet, and buyers who answer
```

**Design decisions worth knowing:**

- **The core is pure.** Scoring, cadence and compliance take their inputs as
  arguments — including the clock. That is why the awkward cases (a reply
  arriving between two scheduled touches, an unsubscribe on a finished
  sequence, a bounce on step one) are covered by tests rather than discovered
  by a prospect who got mailed after asking not to be.
- **The model is optional.** No API key means templates and a heuristic ICP,
  not a crash. Quality drops; the machine keeps running.
- **Disqualifiers are an override, not a weighted signal**, and they match
  against how a company *describes itself*, not against everything on its
  site. A prospect whose engineering blog discusses your problem space is a
  textbook buyer; a company whose homepage says it *is* your product is a
  competitor.
- **Failures are findings.** A lead that cannot be resolved is recorded with
  its error, not dropped.

---

## Known limits

Stated plainly rather than buried:

- **Lead discovery is the weak link without a paid data source.** Directory
  harvesting and search both work, but neither matches Apollo or Clearbit for
  coverage. `ProspectSource` is an interface precisely so you can add one.
- **The heuristic ICP is noticeably worse than the model-derived one.** With no
  API key it infers the target profile from keyword statistics over your own
  marketing copy, which skews toward your solution vocabulary. It is a floor,
  not a substitute.
- **Email only.** `Channel` is modelled for more; only email is implemented.
- **Rate limiting on the public API is per-process**, so on a multi-instance
  deploy the effective limit is per instance.
- **No warmup automation.** You are expected to ramp the sending domain yourself.
- **Meetings are "booked" when the prospect says yes**, not by writing to a
  calendar. Calendar integration is not implemented.

---

## Deploying

Vercel plus any hosted Postgres (Neon, Supabase, Vercel Postgres).

1. Import the repo, set `DATABASE_URL` and `SESSION_SECRET`.
2. `DATABASE_URL="<prod>" npm run migrate:deploy`
3. Run the loop somewhere that stays up — a small worker, a cron, or a
   container running `npm run agent -- --loop`. Serverless functions are the
   wrong shape for it.

The build runs `prisma generate` first, and the schema declares
`binaryTargets = ["native", "rhel-openssl-3.0.x"]` — without the rhel target a
deploy builds fine and then fails at runtime.
