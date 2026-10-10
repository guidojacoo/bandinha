# Market research — autonomous sales agents, late 2026

Why this project is shaped the way it is. Everything here comes from searching
the market before writing code; the conclusions drove specific engineering
decisions, which are linked at the end.

> **Caveat up front:** most published analysis of this category is written by
> vendors competing with the companies being analysed. Specific churn and
> reply-rate figures below repeat across sources that appear to cite each
> other rather than a primary dataset. They are directionally consistent and
> useful for design, but they are not independently verified, and I have not
> treated any single number as load-bearing.

## What already exists

### The funded commercial tier

| Product | Positioning | Reported pricing |
|---|---|---|
| **11x** (Alice) | Fully autonomous AI SDR | ~$36k/yr list; contracts reported at $40–65k |
| **Artisan** (Ava) | Multichannel autonomous SDR | Enterprise, quoted |
| **Regie.ai** | AI-assisted sequences, human in the loop | Mid-market SaaS |
| **Amplemarket** (Duo) | Copilot on top of a human SDR seat | Mid-market SaaS |
| **Clay** | Enrichment + orchestration, human-driven | Usage-based |

### The open-source tier

Several self-hosted AI SDRs exist and some are genuinely well built —
`JamesUgbanu/agent-sdr`, `Kandid-ai/AgentSDR`, `eracle/OpenOutreach`,
`gelevanog/ai-sdr-agent`, and an n8n-based `autonomous-ai-sdr`.

**They share one structural gap.** Read their dependency lists:

- OpenOutreach discovers people "from a licensed data provider"
- autonomous-ai-sdr depends on Apollo and HubSpot
- AgentSDR asks you to bring Google Workspace, Unipile, storage and AI keys
- agent-sdr requires Docker, PostgreSQL 16 and Redis 7 before it does anything

Every one of them is open source *around* a paid core. **Lead discovery is
always someone else's paid API.** That is the expensive part, and nobody has
solved it in the open.

## What is going wrong with the category

Four failure modes come up repeatedly and independently:

**1. Generic AI copy does not get replies.** One analysis puts AI-generated
cold copy at roughly **0.3% reply rate against 4%+ for human-written**;
another frames the same gap as ~13x. The numbers conflict, the direction does
not. Volume without specificity is worth close to zero.

**2. Bad data destroys the sending domain.** If 20–40% of prospect emails
bounce, an autonomous sender burns its reputation within about 90 days — after
which even the wanted mail stops arriving. Bulk-sending tools that do not
verify deliverability are self-terminating.

**3. Full autonomy does not survive contact.** Reported annual churn of
50–70%, and one claim that only ~2% of full-automation deployments are still
running after 90 days. The market is visibly retreating toward human-in-the-loop.

**4. Fabrication is a real scandal, not a hypothetical.** 11x has been
reported for fabricated customer claims and disputed logos, with ZoomInfo
threatening legal action; Artisan for hallucinated customer news. An agent
that invents a proof point does not just send a bad email — it makes a false
statement about a third party, in writing, under your name.

And a fifth, specific to 2026: **Artisan's LinkedIn automation was restricted**
at the start of the year, removing a channel it was built on. Any design that
depends on a platform tolerating automation is one policy change from dead.

## Where the opening is

The commercial tier charges $36–65k/yr and is churning. The open tier is free
right up until the part that costs money. Nobody is serving the person who
says *"I sell a thing, I have no budget, find me customers."*

That gap is addressable because the paid data layer is substitutable for a
large share of real businesses:

- **If you sell developer tooling**, GitHub's API is the best prospect
  database in existence and it is free — searchable by language, topic,
  dependency and activity, with organisations, websites and public contacts
  attached.
- **If you sell to local businesses** (restaurants, clinics, gyms, trades),
  **OpenStreetMap via Overpass** has millions of them with websites, emails
  and phone numbers, free, no API key, no account.
- **If you sell to companies using a specific technology**, the public package
  registries (npm, PyPI, crates.io) expose who publishes and depends on what.
- **Industry directories, association member lists and marketplace catalogues**
  are public web pages, and harvesting them is how human SDRs have always
  prospected without a data budget.

None of this matches Apollo for coverage. All of it is free, and together it
covers an enormous share of small businesses — which is precisely the segment
priced out of the commercial tier.

## The thesis

> A sales agent that is free end to end, discovers leads from open data, and
> is **structurally incapable** of the four things that are killing the paid
> tier.

"Structurally incapable" is the important part. Each failure mode is answered
by a gate in code, not by an instruction in a prompt:

| Failure mode | What this project does | Where |
|---|---|---|
| Generic copy, 0.3% replies | **Evidence-or-silence.** A message cannot be sent unless it quotes something the crawler actually found on *that prospect's own site*. No evidence, no send — the lead is skipped, not spammed. | `core/evidence.ts` |
| 20–40% bounces burning the domain | **Deliverability pre-flight.** Syntax, role-inbox, disposable-domain and MX checks before a message is ever handed to a transport. | `core/deliverability.ts` |
| Fabricated claims | **Provenance ledger.** Every factual claim in every message must resolve to a source URL that was actually crawled, and is stored with the message. A claim that does not resolve fails the draft. | `core/provenance.ts` |
| 2% survival of full autonomy | **Bounded autonomy.** Autonomous research, qualification, drafting, sending and objection handling; a hard stop at commitment, pricing and routing, where being wrong costs money or credibility. | `core/classify.ts`, `agent/converse.ts` |
| $36–65k/yr | **Open-data discovery.** GitHub, Overpass, package registries, directories. The paid provider becomes an optional plugin rather than the foundation. | `infra/sources/` |
| Free LLM tiers are small | **Token budgeting.** Groq's free tier is ~200K tokens/day on larger models. The agent rations it, prefers small models for classification, and degrades to deterministic templates when exhausted rather than failing. | `core/budget.ts` |

## What this is not

It will not out-cover Apollo. It will not beat a good human SDR on reply rate.
It is not a way to send more email than you could before — the volume caps are
deliberately low, because the research is unambiguous that volume is what
kills senders.

It is a way for someone with no budget to run a disciplined outbound motion
that would otherwise cost $36,000 a year, and to do it without the four
specific mistakes that are currently churning the people who pay that.

## What building it changed

Four things the research above got wrong, or got right for the wrong reason.
Recorded here rather than quietly corrected, because the plan is only useful
if the corrections are visible next to it.

**PyPI is not usable, and robots.txt is why.** It was named above as the
Python counterpart to npm. Its `robots.txt` disallows both the search path and
the per-project JSON endpoint, and this project's crawler honours robots.txt
— so there is no permitted search surface. Python-ecosystem prospects come
from GitHub filtered by language instead. crates.io returns 403 to an
unauthenticated client and was dropped for the same kind of reason.
Centralising every outbound request through one fetch path is what surfaced
this before it shipped rather than after.

**npm turned out to be the strongest proven source, not a footnote.** It was
listed third, after GitHub and Overpass. It is the one that worked end to end:
a company publishing a package in your space has already told you that it
exists, what it works on, and the domain of its website, and `links.homepage`
on its own domain is the filter that separates a business from a weekend
project. A live run against an observability ICP returned Pulumi, Langfuse,
Mastra, Backstage, Pydantic, Spotify and Microsoft.

**"Free LLM tier" is a weaker claim than it looks, and that is fine.** The
budget gate was designed for a tier that runs out. What the build showed is
that the deterministic path has to be a *first-class product surface*, not a
fallback: it derives the offer, the ICP, the copy and the replies, and it has
to pass exactly the same validator. The honest version of "free" is not "free
until the quota goes" — it is "the quota changes how good it is, never whether
it works".

**The evidence gate is harder than stating it.** "Quote something from their
own site" is one sentence of design and a dozen failure modes in practice:
cookie banners, navigation menus flattened into a line, noun-pile headings,
recruiting copy addressed to a candidate, and ordinary prose that a naive
short-word heuristic reads as a menu. Each of those reached a draft message
during the build. The gate is now about a third of the code it guards.

## What the second pass changed

Three more corrections, from building the parts the first pass left as
intentions.

**"Specific copy" is not one gate, it is two.** The research framed the
0.3%-versus-4% reply gap as a specificity problem, and the evidence gate
answers that. What it does not answer is whether the resulting sentence is
worth reading — and a message can be perfectly specific and still open with
"I hope this finds you well", ask three questions, and run to 160 words. So
specificity and quality are now measured separately, and the finding that
forced it was embarrassing: a four-touch sequence where every message scored a
perfect quality 100 and all four were *the same email*. Quality is a property
of the sequence, not of the draft.

**Performance pricing only works if the units are provable.** The obvious
objection to charging per meeting is that the vendor decides what a meeting
is. The agent's existing refusals turn out to be the answer: it already will
not assert a closed deal, so a win can only be recorded by a payment or a
person — which makes it billable. A meeting is billable only once a human
confirms it, because the reply classifier is good and not perfect, and most of
the time is not a standard you can invoice to. The gates built for honesty
turned out to be the billing guarantees.

**The free claim has a hard edge, and it is collection.** Leads, inference,
storage and sending are all free or already paid for. Raising an invoice is
free. Taking money is not: every payment rail charges a percentage. Saying so
is better than quietly implying otherwise, and it is why the payment path is a
signed webhook rather than a provider SDK — the provider is the operator's
choice and the operator's cost.

## Sources

- [Top 5 AI Sales / SDR Tools in 2026](https://guptadeepak.com/tools/top-5-ai-sales-sdr-tools-2026/)
- [8 best AI sales agents and AI SDR tools in 2026, compared](https://www.amplemarket.com/blog/best-ai-sales-agents)
- [We Compared AI SDR and Sales Agent Tools So You Don't Have to](https://close.com/blog/ai-sdr-sales-agent-tools-compared)
- [AI SDR Tools Compared: What Actually Works for B2B Pipeline in 2026](https://salesmotion.io/blog/ai-sdr-tools-compared)
- [We Tried 9 AI Sales Agents (AI SDRs) For B2B Lead Generation](https://www.salesforge.ai/blog/ai-sales-agents)
- [AI Sales Agent in 2026: What Actually Works](https://lead-scorer.com/blog/hybrid-ai-sales-agent-2026)
- [agent-sdr](https://github.com/JamesUgbanu/agent-sdr) · [AgentSDR](https://github.com/Kandid-ai/AgentSDR) · [OpenOutreach](https://github.com/eracle/OpenOutreach) · [ai-sdr-agent](https://github.com/gelevanog/ai-sdr-agent)
- [Groq free tier rate limits](https://benchlm.ai/free-tier/groq) · [Groq pricing 2026](https://tokenmix.ai/blog/groq-api-pricing)
