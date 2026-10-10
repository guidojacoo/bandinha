# Mercurio

An outbound sales agent that finds its own leads in open data, writes only
what it can prove, measures its own copy, and costs nothing to run. Bill per
contact delivered or per deal closed — on units the system holds the evidence
for.

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
| Copy nobody would read | Eleven measured checks. A draft below the bar is rewritten against the checks it failed, best-of-N, and the template competes on the same score. | `src/core/quality.ts` |
| Billing a client for nothing | A unit is chargeable only when the evidence for it is in the database. A meeting needs a person; a win needs a payment. | `src/core/billing.ts` |
| A burned sending domain | The daily cap ramps over four weeks and throttles itself on bounces and complaints. | `src/core/warmup.ts` |
| Measuring copy but never learning | Replies are attributed back to signal, source, step and quality band — with the honesty to say when a sample is too small to mean anything. | `src/core/learning.ts` |
| Paid data vendors | Ten free discovery sources, routed by what the ICP actually is. | `src/infra/sources/` |

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
  ✓ the agent closed no deal by itself
  ✓ billed one contact per prospect, not one per message
  ✓ one reply charge per prospect, none for a bounce or a complaint
  ✓ a meeting was billed only after a person confirmed it
  ✓ every won deal was closed by a payment or a person
  ✓ every charge carries its evidence
  ✓ nothing sent to a suppressed address afterwards

  All 17 checks passed.
```

```
8. Totals
  discovered   9        qualified    5        rejected     4
  enrolled     5        sent         5        blocked      0
  replies read 7        answered     2        escalated    2
  suppressed   2
```

The run also confirms a meeting, takes a payment through the signed webhook,
proves an *unsigned* one is refused, and prints the invoice with its evidence.

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
npm run health                        # is anything wrong, is anything waiting
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

### Leaving it running

`deploy/` has cron, systemd and GitHub Actions recipes, all free. Three things
make unattended running safe, and they matter more than the scheduler you pick:

**A lock.** Every tick takes a per-campaign lock first. A schedule firing
every ten minutes against a tick that occasionally takes twelve *will*
overlap, and two overlapping ticks both read "sent today: 4", both decide
there is room, and quietly double the daily cap, the per-domain cap and the
anti-pester gap. A second tick finding the lock held skips rather than queues,
and says so.

**A warmup ramp.** The daily cap is not a constant. It starts at 15% of what
you configured, reaches the full figure over about four weeks, halves itself
when bounces pass 2% or complaints pass 0.15%, and stops entirely at 5% and
0.3% — the last of which is Gmail's published number and the one figure in
deliverability that is not folklore. A new domain that sends its full volume
on day one is a new domain with a damaged reputation, and the damage is
invisible for weeks: by the time the reply rate drops, the mail has been going
to spam for a fortnight and the only fix is a new domain.

A verdict never blocks a *reply*. A halt is about not sending unwanted mail to
strangers; somebody who wrote to you and is waiting is the opposite case.

**A failure ceiling.** `--loop` stops after three consecutive failures, with
exponential backoff between them. A loop that retries forever on a broken
campaign looks identical to one that is working, which is the worst property
an unattended process can have.

`npm run health` answers the only two questions that matter once it is on a
timer — is anything wrong, and is anything waiting for a person — and exits
non-zero when the answer is yes, so a monitoring check can watch it rather
than parse it.

---

## The copy is measured, not hoped for

"Write a good email" is not something a prompt can be trusted to deliver, so
every draft is scored before it is sent — on length, the opening sentence,
filler, specificity, a single ask at the end, the you-versus-we balance,
hedging, jargon, readability, formatting, and whether it repeats an earlier
message. A draft below the threshold is rewritten against the specific checks
it failed, and the score is stored with the message, so a drop in copy quality
is visible before the reply rate shows it.

```
step 1  first_touch   100/100   "forty pages a week"
step 2  value_add      94/100   "on-call engineers paged"
step 3  social_proof  100/100   "on-call engineers paged"
step 4  breakup       100/100   "closing the loop — Fableworks"
```

Composing is best-of-N rather than first-that-passes, against two bars that
fail differently. `validateDraft` is about truth and legality: an unsupported
claim or a missing postal address is fatal and no rewriting counts.
`scoreQuality` is about whether the thing is worth reading, where a second
attempt is usually better but not always. The deterministic template is a
*competitor* in that comparison, not a last resort — if the model cannot beat
it on the same scoring, the template goes out.

The finding that justified building this: the first version of the templates
ignored the step intent entirely and produced **the same email four times**,
and every one of them scored a perfect 100 on its own. Quality is a property
of the sequence, not only of the draft, so repetition is now a disqualifier
rather than a demerit — a resend scores well on every other check, because it
was a good email the first time.

A note on the ask. It asks about their situation, not their calendar:

> Is alert noise something you are already working on, or has it just become
> background?

"Do you have fifteen minutes" wants a commitment before they know whether they
care. The question above costs them one line, and the meeting becomes obvious
in the conversation it starts.

### And it learns which of it worked

`/learning` attributes real replies back to the attributes of the messages
that earned them — which pain signal the prospect wrote about, which registry
the lead came from, which touch in the sequence, which quality band, named
person or shared inbox. The two that matter most are the first two, because
they change *who* gets contacted, and that matters more than how.

Three decisions make it an instrument rather than a dashboard:

**It ranks by the lower bound, not the rate.** One reply from one send is a
100% reply rate and tells you nothing; forty from two hundred is 20% and tells
you a lot. A Wilson lower bound asks "given this sample, what is the worst the
true rate plausibly is" — and unusable samples are sorted out of the ranking
entirely, because the interval alone does not fix it: at n = 1 with one reply
the lower bound is 21%, *above* a solid 15%.

**It refuses to answer when it cannot.** Below twelve sends a value gets its
counts and no rate at all, and a comparison whose intervals overlap says
"these cannot be told apart yet" instead of picking a winner. Most comparisons
at these volumes are exactly that.

**It says it is observational.** A real A/B test needs hundreds of sends per
arm and the volume caps deliberately prevent that, so this measures messages
that were sent anyway: it finds correlation and cannot establish cause. In
practice that is usually enough to act on — if prospects who wrote about
on-call pain reply and prospects who merely mention Kubernetes do not, change
the ICP whether or not the mechanism is proven — but a finding is a reason to
look, not a result.

Findings that hold up are passed back into the composing prompt as context,
never as instruction. A fourteen-send coincidence turned into a rule becomes
the house style, and then every later measurement is of a market the agent has
already narrowed itself to.

---

## Charging for it: per contact, or per sale

The commercial shape this makes possible is running outbound for somebody and
billing them for what it produced, instead of paying $36k a year for a seat.
Four unit types, priced in `/billing`:

| Unit | Chargeable when |
|---|---|
| **Contact delivered** | A first message actually left for an address that passed the deliverability pre-flight. One per prospect — a four-touch sequence is one contact, not four. |
| **Reply received** | A human replied. One per prospect, and never for a bounce, an out-of-office, or somebody asking to be left alone. |
| **Meeting confirmed** | A person confirmed the reply really was a meeting. The classifier alone is not a standard you can bill a client to. |
| **Deal won** | A payment or a countersignature closed it. Flat fee, or a share of a recorded value. |

The rule underneath all four: **a unit is billable only when the system holds
the evidence for it.** Every invoice line carries that evidence, so a client
can check the bill against reality rather than taking it on trust — the same
argument the product makes about its own copy:

```
Item                          Qty        Rate        Amount
------------------------------------------------------------
Contacts delivered              5       $0.50         $2.50
Replies received                4       $5.00        $20.00
Meetings confirmed              1      $50.00        $50.00
Deals won                       1       share     $1,080.00
------------------------------------------------------------
Total                                             $1,152.50

What you are being charged for
------------------------------------------------------------
Deals won:
  2026-10-13  Meridian Pay (meridianpay.test)
      Closed by a payment (pi_demo_3Kx91) on 2026-10-13.
```

Prices are deliberately weighted toward outcomes. Charging mostly per contact
rewards volume, which is exactly the behaviour the research says destroys a
sending domain — the price list should not pull against the product's own
gates. There is no deal value guessed, ever: no recorded value means no
revenue share, because inventing a deal size to bill a percentage of it is the
billing version of fabricating a proof point.

### Getting paid

`POST /api/payments/<clientId>` is the only route that can mark a deal won,
and it is the counterpart to the agent being forbidden from asserting one.
Signed with HMAC-SHA256 over the raw body, compared in constant time, so any
provider works — Stripe, Lemon Squeezy, Mollie, a bank notification, or a
script you run after a transfer clears. No provider SDK and no account stands
in front of the one feature that closes the loop.

**What costs money.** Running the agent is free: open data for the leads, a
free model tier, SQLite on disk, your own SMTP. Raising an invoice is free —
it is plain text with the evidence attached. *Collecting* is the one thing
that is not, because every payment rail takes a percentage. That is the honest
edge of the claim and no amount of engineering removes it.

---

## Where the leads come from

Six sources, picked by what the ICP is. A developer tool asks package
registries who publishes in its space; a salon booking tool asks OpenStreetMap
what salons exist in a city. Neither could serve the other, and no single free
source covers everyone, so `src/core/icp.ts` routes.

| Source | What it covers | Status |
|---|---|---|
| **npm** | JavaScript and TypeScript. The largest registry by far. | **Proven** |
| **Packagist** | PHP and Composer. Commercial, agency-heavy — and the only registry that publishes a named maintainer's address in the package itself. | **Proven** |
| **RubyGems** | Ruby, which means Rails, which means a great many small businesses. | **Proven** |
| **crates.io** | Rust. Small, and almost entirely infrastructure. | **Proven** |
| **Hex.pm** | Elixir and Erlang. The smallest, with correspondingly little noise. | **Proven** |
| **Directory pages** | Companies listed on pages you supply — association members, conference exhibitors, market roundups. One good page can yield fifty on-target domains. | **Proven** |
| **Seed list** | Companies you already know about. Always last, cannot fail. | **Proven** |
| **GitHub** | Organisations publishing code in the ICP's space. The richest source for a software ICP. | Built, untested |
| **OpenStreetMap** | Local businesses with a mapped location: shops, clinics, restaurants, trades. | Built, untested |
| **SearXNG** | Anything the web indexes. Broad coverage, low precision. Needs an instance; run your own. | Built, untested |

The five registries are one code path with per-registry adapters, because the
insight is identical in all five and the parts that are easy to get wrong —
the company-domain filter, de-duplication, the staleness cutoff, refusing the
registry's own documentation site as a "company homepage" — should be got
right once. Adding a sixth is a fifteen-line adapter.

**The order is chosen, not fixed.** A seller whose site says "Laravel" asks
Packagist before npm: npm is an order of magnitude larger, and that does not
help if it is larger in the wrong market. With no ecosystem named, the order
is by registry size, because recall is what matters when precision has nothing
to work with.

A live run against an observability ICP found Pulumi, Langfuse, Backstage,
Elastic, LaunchDarkly, Bugsnag, Treblle, Mirantis, Databricks and Spotify —
fourteen of twenty-four with a maintainer's address published in the package
metadata, which is a better lawful basis than a crawl, since the person chose
to publish it. The page that published it is recorded with the address,
because "where did you get my email" is a question with a legal answer.

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

**crates.io was dropped and then recovered.** It was written off as returning
403 to unauthenticated clients. It returns 403 to clients with no
`User-Agent` — a different thing, and one this project's fetch path never
does. "The API refused me" and "I asked badly" look identical from the
outside.

---

## Groq, and what has actually been run

Set `GROQ_API_KEY` and the model writes the copy, derives the offer and reads
the replies. `GROQ_BASE_URL` points at anything OpenAI-compatible, so a local
llama.cpp or vLLM works too — the other way to keep inference free.

Groq is unreachable from the machine this was built on, which would have left
the most load-bearing integration in the product asserted rather than run. So
the protocol is implemented instead, and the whole thing runs against it:

```bash
npm run mock:groq      # a server that speaks Groq, in another terminal
GROQ_BASE_URL=http://127.0.0.1:8099/openai/v1 GROQ_API_KEY=test-key npm run demo
```

It is a deliberately difficult server. The first compose request returns what
a model actually produces on a first pass — "I hope this finds you well", two
questions, a hedge, a buzzword — so the scorer rejects it and the critique loop
has to work. Its ICP response hands back a size band the wrong way round and a
claim attributed to a page that does not exist. A mock that always answered
perfectly would prove nothing about the part of the system built to handle
imperfection.

Seventeen wire tests cover: token accounting taken from the provider rather
than our estimate, the model and cap actually sent, prose-and-fence JSON
extraction, a 429 honoured for the 1.3 seconds its body asks for (Groq puts
the wait in the error message, with no `Retry-After` header), a rate-limited
attempt still charged to the budget, a 503 retried, a bad key degrading after
exactly one request, the budget enforced before the socket rather than after,
the first draft rejected with the critique carrying the scorer's own findings
into the next prompt, and a commitment escalating without the model being
consulted at all.

**What this cannot prove is whether the real model writes well.** It proves
that when the model writes badly, the system notices and fixes it.

## It also works without an LLM

Leave the key unset and the offer, the ICP, the copy and the replies are all
derived deterministically — and that path is a first-class product surface,
not a stub. It produces the same shapes, carries the same provenance, passes
exactly the same validator, and clears the same quality bar.

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
  quality.ts       is this copy worth reading? eleven measured checks
  learning.ts      what actually got replies, and when you cannot tell
  warmup.ts        how much may go out today without burning the domain
  billing.ts       what may be charged for, and the evidence each unit needs

src/infra/       everything that touches the outside world
  http.ts          the only place that calls fetch: robots, delays, size caps
  lock.ts          so two ticks cannot double-send
  extract.ts       HTML into facts (pure, so every rule is testable)
  crawler.ts       a polite, budgeted, priority-ordered site crawler
  dns.ts           MX lookups
  llm/             Groq, where degrading is a first-class outcome
  sources/         ten open-data prospect sources; five are one adapter path
  transport/       outbox (default), SMTP, IMAP
  db.ts            SQLite via Prisma, plus the persistent token ledger

src/agent/       the pipeline
  ingest.ts        one URL -> a sellable position
  qualify.ts       a domain -> a decision, with the reason recorded
  compose.ts       the message, quote first, claims declared
  converse.ts      answering a reply, and knowing when not to
  deals.ts         stages derived from what happened, terminal stages absorb
  billing.ts       raising charges from facts, and the only path to `won`
  learning.ts      attributing replies back to what produced them
  orchestrator.ts  one tick: replies, discover, qualify, enrol, send

src/app/         the operator console (Next.js)
src/cli/         setup, sell, agent, demo, doctor, discover
deploy/          cron, systemd and GitHub Actions recipes, all free
fixtures/        ten sites, five scripted buyers, and a server that speaks Groq
test/            644 tests
```

The split is the point. Everything that has to be *right* — who may be
contacted, whether a claim is true, whether an address will bounce, what a
reply means, when the next touch is due, whether the copy is worth reading,
what may be charged for — is a pure function with its inputs passed in. That
is why the dangerous paths can be tested exhaustively without an inbox, a
resolver, or a model.

Two test files are deliberately not pure: `groq-wire` runs the real client
against the protocol server, and `payments` exercises the only route that can
record money, against a throwaway database rather than yours.

```bash
npm test         # 607 tests, ~17s
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

Three of six discovery sources, the SMTP transport, the IMAP reader and the MX
verifier are complete and unexercised, for the network reasons above. They are
marked as such everywhere they appear. The pure core, the npm, directory and
seed sources, the crawler, the extractor, the full agent pipeline, the model
client against Groq's protocol, the quality scorer, the billing layer, the
payment webhook, the dry-run transport and the console are all proven end to
end by `npm run demo`, `npm run discover` and 644 tests.

And one thing worth saying plainly about the copy: it is measured, and
measuring is not the same as selling. The scorer encodes what is known to
correlate with replies — specificity, brevity, one ask, no filler. Whether a
particular market replies to a particular sentence is a question only sending
answers, which is what the quality score stored on every message is for.
