# Mercurio

An outbound sales agent that finds its own leads in open data, writes only
what it can prove, and costs nothing to run.

Paste the URL of whatever you are selling. The agent reads that site, works
out what the offer is and who buys it, goes and finds those companies in
public registries and maps, reads their websites, and writes to the ones whose
own pages show the problem you solve. It handles the replies, answers
objections, and stops at the three points where being wrong costs money.

No paid data vendor. No seat licence. No API key that is required rather than
optional. SQLite on disk, Groq's free tier for the model, open data for the
leads.

---

## Why

The market research is in **[docs/RESEARCH.md](docs/RESEARCH.md)**. Three
findings shaped everything:

**The commercial tier charges $36–65k a year and is churning.** Reported
annual churn of 50–70%, and one claim that ~2% of full-automation deployments
survive 90 days. The market is visibly retreating to human-in-the-loop.

**The open-source tier is open source *around a paid core*.** Every
self-hosted AI SDR delegates lead discovery to Apollo, ZoomInfo or Clearbit.
That is the expensive part, and nobody had solved it in the open. It is the
problem this project actually attacks.

**Four failure modes keep recurring, and all four are answerable in code.**
Generic copy getting 0.3% replies against 4%+ for human-written. 20–40% bounce
rates burning a sending domain inside 90 days. Fabricated customer claims, with
legal threats following. And autonomy that does not survive contact with a real
buying conversation.

So the design rule is *structurally incapable*, not *instructed not to*:

| Failure mode | The gate | Where |
|---|---|---|
| Generic copy | A message that cannot quote something found on **that prospect's own site** is not sent. The lead is skipped. | `src/core/evidence.ts` |
| Bounces | Syntax, never-contact, disposable, role-inbox and MX checks before a transport is ever handed an address. Fails closed when no check ran. | `src/core/deliverability.ts` |
| Fabrication | Every factual claim is traced back to text actually crawled, before the message goes out. A claim that cannot be traced rejects the draft. | `src/core/provenance.ts` |
| Autonomy that overreaches | Handles objections itself; stops at commitment, pricing and routing. Never marks its own deal won. | `src/core/classify.ts` |
| Free tiers run out | The day's token allowance is rationed per task, so extraction cannot starve a reply to a live prospect. | `src/core/budget.ts` |
| Paid data vendors | Six free discovery sources, routed by what the ICP actually is. | `src/infra/sources/` |

---

## Try it in two minutes

```bash
npm install
npm run setup          # creates .env, the database, and your account
```

Then, in two terminals:

```bash
sudo npm run fixtures:hosts   # point the demo's .test names at localhost (once)
npm run fixtures              # serve the bundled fixture web
```

```bash
npm run demo                  # watch a full run
```

The demo runs against ten fixture sites on reserved `.test` names rather than
real companies, because the honest ways to demonstrate this are both bad:
crawl strangers hard enough to show a crawler, or mail strangers to show a
mailer. Four of the nine prospects are built to be rejected — a competitor, a
two-person studio, a company with nothing quotable, and one that publishes
only `abuse@` — and the demo asserts that each was rejected for the right
reason. A gate that quietly stopped working would pass a demo that only counted
emails.

A fifth is a deliberate known miss, kept rather than reworded to suit the
code: it phrases the problem as "bad enough to wake somebody up" where the
seller's site says "stop being woken", and bridging that gap is what an LLM is
for. So the run contacts four of nine with no model configured.

Expected output, end of run:

```
8. Did the gates actually fire?
  ✓ burnrate.test rejected                         Disqualified: they describe themselves as "error budget tracking"
  ✓ tinycrew.test rejected                         Fit 53 is below the 60 threshold
  ✓ opaque.test rejected                           Nothing specific enough to write about was found
  ✓ noreply.test rejected                          Fit 57 is below the 60 threshold
  ✓ competitor disqualified on self-description
  ✓ abuse@ and privacy@ never mailed
  ✓ no message sent without a postal address
  ✓ no message sent without a way out
  ✓ every claim traced to a crawled page
  ✓ opt-out suppressed globally
  ✓ commitment and pricing escalated, not closed
  ✓ nothing sent to a suppressed address afterwards

  All 12 checks passed.
```

```
7. Totals
  discovered   9        qualified    4        rejected     5
  enrolled     4        sent         4        blocked      0
  replies read 6        answered     2        escalated    1
  suppressed   2
```

Read `./outbox` afterwards. Those `.eml` files are exactly what would have been
sent.

### Then prove the discovery half against the real internet

```bash
npm run discover
```

This one does not use fixtures. It runs the open-data sources live and prints
what they return, which is the half of the claim that cannot be faked. From a
developer-tooling ICP it finds real companies — Pulumi, Langfuse, Mastra,
Backstage, Pydantic — with no paid vendor involved.

### And the console

```bash
npm run dev    # http://localhost:3000
```

---

## Running it for real

```bash
npm run sell -- https://your-company.com
npm run agent -- <campaignId> --loop
```

`npm run sell` reads your site, prints the offer and the ICP it derived, asks
for a sender identity, and creates the campaign. `npm run agent` ticks: reads
replies, discovers, qualifies, enrols, sends. A tick is idempotent and
resumable, so it works equally as a one-shot, a loop in a terminal, or a cron
entry.

**Nothing reaches a real inbox until two separate things are true**: SMTP is
configured in `.env`, *and* that campaign has live sending armed in the
console with a typed confirmation. Either one alone is a dry run. A stray
environment variable should not mail three hundred strangers.

`npm run doctor` tells you what works on your machine and what does not —
every check is run live rather than inferred from configuration.

---

## Where the leads come from

Six sources, picked by what the ICP is. A developer tool asks package
registries who publishes in its space; a salon booking tool asks OpenStreetMap
what salons exist in a city. Neither could serve the other, and no single free
source covers everyone, so `src/core/icp.ts` routes.

| Source | What it covers | Status |
|---|---|---|
| **npm** | Companies publishing JavaScript or TypeScript packages. Strong for developer tools and infrastructure. | **Proven** |
| **Directory pages** | Companies listed on pages you supply — association members, conference exhibitors, market roundups. One good page can yield fifty on-target domains. | **Proven** |
| **Seed list** | Companies you already know about. Always last, cannot fail. | **Proven** |
| **GitHub** | Organisations publishing code in the ICP's space. The richest source for a software ICP. | Built, untested |
| **OpenStreetMap** | Local businesses with a mapped location: shops, clinics, restaurants, trades. | Built, untested |
| **SearXNG** | Anything the web indexes. Broad coverage, low precision. Needs an instance; run your own. | Built, untested |

### What "untested" means, precisely

Three sources are complete and unproven. They were written on a machine whose
network could reach the npm registry and essentially nothing else: GitHub's
API was scoped to a single repository and returned 403 to `/search` and
`/orgs`, every Overpass mirror was unreachable, and so was every public
SearXNG instance. The endpoints, their rate limits and their response shapes
are public and stable. What has not been exercised is this code against them.

They are labelled in the code, in the console and here, rather than quietly
shipped as working, because a lead source that silently returns nothing looks
exactly like an ICP with no market — and an operator chasing the wrong one of
those loses an afternoon. `npm run discover` tells you which of them work from
where you are.

**PyPI was planned and dropped.** Its `robots.txt` disallows both the search
path and the per-project JSON endpoint, and this crawler honours robots.txt, so
there is no permitted search surface. Python-ecosystem prospects come from
GitHub filtered by language instead.

---

## It works without an LLM

Set `GROQ_API_KEY` and the model writes the copy, derives the offer and reads
the replies. Leave it unset and all of that is derived deterministically
instead — and that path is a first-class product surface, not a stub. It
produces the same shapes, carries the same provenance, and passes exactly the
same validator.

This matters because the free tier runs out. An agent that stops working at
that point is not free, it is a trial. So the honest version of the claim is:
the quota changes how good the copy is, never whether the agent works.

The deterministic path is slightly worse at generalising vocabulary. One
fixture prospect is deliberately left as a known miss: it phrases the problem
as "bad enough to wake somebody up" where the seller's site says "stop being
woken", and bridging that is what a model is for.

---

## Bounded autonomy, stated plainly

The agent does, on its own: read your site, derive the ICP, choose sources,
discover companies, crawl them, score fit, verify addresses, write the
message, send it, read the reply, classify it, and answer an objection.

It stops at three things, every time:

- **Commitment.** "Send the contract" goes to a person. The agent cannot sign,
  invoice, or mark its own deal won — a closed deal needs a payment, a
  countersignature, or somebody saying so. The console shows these first.
- **Pricing.** Quoting a number for "a team of 30" means inventing a price you
  never published.
- **Routing.** A referral changes who the deal is with, which is not the
  agent's call.

Plus anything it is not confident about. Two outcomes need no model at all and
are absorbing: an opt-out suppresses the address globally and permanently, and
a bounce stops the sequence.

This is the honest version of "fully autonomous": autonomous through the part
that is drudgery, escalating the part where being wrong costs money or
credibility. The research is unambiguous that the alternative is what churns.

---

## Sending lawfully, which is also sending effectively

Unsolicited bulk mail to harvested addresses is unlawful in most of the world
— CAN-SPAM §7704, GDPR Art. 6, Ley 25.326 — and the practices that make it
unlawful are the same ones that burn a sending domain. So these are not
options:

- Every message carries a real sender name, a working reply address and a
  **postal address**. The validator refuses a draft without one.
- Every message carries a way out, and a `List-Unsubscribe` header with
  one-click support, which Gmail and Yahoo have required of bulk senders since
  2024.
- Suppression is global per operator and permanent. An opt-out from one
  campaign applies to every campaign, and the only suppressions that can be
  removed are ones added by hand.
- `abuse@`, `postmaster@`, `privacy@`, `security@`, `legal@`, `dpo@`,
  `careers@`, `press@` and `billing@` are never contacted, at all.
- Volume caps default low: 30 a day, 2 per domain, 48 hours between touches,
  business hours only, weekdays only. A new sending domain that emits two
  hundred messages on its first day is a new sending domain with a ruined
  reputation.
- The crawler honours `robots.txt`, spaces requests per host, identifies
  itself, and caps response size.

You send as yourself, from your own server, on your own domain. That is the
only arrangement that is both free and lawful — and a shared sending domain
would be burnt within a week by whoever used it least carefully.

---

## How it is put together

```
src/core/        pure: no network, no database, no clock except one passed in
  types.ts         the domain model; SQLite has no enums, so these unions are it
  evidence.ts      the gate: is there anything specific to say?
  deliverability.ts will this address bounce?
  provenance.ts    is this claim supported by something we actually read?
  fit.ts           how good a prospect is this, and why
  compliance.ts    may we send this, right now, to this person?
  sequence.ts      when is the next touch due? (a total, pure reducer)
  classify.ts      what does this reply mean, and who should handle it?
  draft.ts         mechanics, fabrication and specificity, in one validator
  icp.ts           who buys this, and which free sources can find them
  budget.ts        how much of today's free tier is left, per task

src/infra/       everything that touches the outside world
  http.ts          the only place that calls fetch: robots, delays, size caps
  extract.ts       HTML into facts (pure, so every rule is testable)
  crawler.ts       a polite, budgeted, priority-ordered site crawler
  dns.ts           MX lookups
  llm/             Groq, where degrading is a first-class outcome
  sources/         the six open-data prospect sources
  transport/       outbox (default), SMTP, IMAP
  db.ts            SQLite via Prisma, plus the persistent token ledger

src/agent/       the pipeline
  ingest.ts        one URL -> a sellable position
  qualify.ts       a domain -> a decision, with the reason recorded
  compose.ts       the message, quote first, claims declared
  converse.ts      answering a reply, and knowing when not to
  deals.ts         stages derived from what happened, terminal stages absorb
  orchestrator.ts  one tick: replies, discover, qualify, enrol, send

src/app/         the operator console (Next.js)
src/cli/         setup, sell, agent, demo, doctor, discover
fixtures/        ten sites and five scripted buyers, for the end-to-end proof
test/            428 tests, none of which need a network
```

The split is the point. Everything that has to be *right* — who may be
contacted, whether a claim is true, whether an address will bounce, what a
reply means, when the next touch is due — is a pure function with its inputs
passed in. That is why the dangerous paths can be tested exhaustively without
an inbox, a resolver, or a model.

```bash
npm test         # 428 tests, ~3s
npm run typecheck
```

---

## What this is not

It will not out-cover Apollo; free sources are partial and the ones here are
strongest for software companies and local businesses. It will not beat a good
human SDR on reply rate. It is not a way to send more email than you could
before — the caps are deliberately low, because volume is what kills senders.

It is a way to run a disciplined outbound motion that would otherwise cost
$36,000 a year, without the four specific mistakes currently churning the
people who pay that.

Three of six discovery sources, the SMTP transport, the IMAP reader, the MX
verifier and the Groq client itself are complete and unexercised, for the
network reasons above. They are marked as such everywhere they appear. The
pure core, the npm, directory and seed sources, the crawler, the extractor,
the full agent pipeline, the dry-run transport and the console are all proven
end to end by `npm run demo` and `npm run discover`.
