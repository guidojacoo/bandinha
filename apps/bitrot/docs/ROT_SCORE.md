# The Rot Score

How Bitrot turns public registry metadata into a 0–100 number, and why it is
shaped the way it is.

**Everything below is implemented in [`src/lib/rot/`](../src/lib/rot/) and
covered by [`test/score.test.ts`](../test/score.test.ts) and
[`test/signals.test.ts`](../test/signals.test.ts).** Those tests are the
specification; this document explains the reasoning.

## What the score measures

Lifecycle risk: *how likely is this dependency to stop being maintainable
under you?* That is a different question from "does this version have a CVE",
which is what `npm audit`, Dependabot, Snyk and Grype already answer well.

It is explicitly **not** a measure of code quality, popularity, or how much you
depend on the package. See [Known limits](#known-limits).

Higher = more rot. 0 is a healthy package.

## The eight signals

Each signal produces a rot contribution in `[0,1]` and carries a weight.

| Signal | Weight | Fires when |
|---|---:|---|
| Deprecated | *override* | npm `deprecated` on latest, PyPI yank, or `Development Status :: 7 - Inactive` |
| Staleness | 30 | Time since the most recent release |
| Release cadence | 15 | Releases in the last year vs. the year before |
| Bus factor | 12 | Few accounts can publish a fix |
| Version drift | 12 | Major versions between what you run and latest |
| License clarity | 8 | No usable license identifier in the metadata |
| Maturity | 8 | Brand-new package with no track record |
| Source provenance | 5 | No repository URL linked |

### Staleness (weight 30)

Piecewise-linear in days since the last release, saturating at four years:

| Age | Contribution |
|---|---|
| ≤ 180 days | 0 |
| 180 → 365 | 0 → 0.35 |
| 365 → 730 | 0.35 → 0.70 |
| 730 → 1460 | 0.70 → 1.0 |
| > 1460 days | 1.0 |

Six months of quiet is normal for a stable library. Four years is not, and past
that point more silence adds no information.

### Release cadence (weight 15)

Compares releases in the last 365 days (`r₁`) against the 365 before that (`r₂`):

- `r₁ = 0, r₂ > 0` → **1.0**. Releases stopped. The sharpest available signal.
- `r₁ = 0, r₂ = 0` → 0.85. Silent for two years.
- `r₁ ≥ r₂` → 0. Cadence steady or rising.
- otherwise → `1 − r₁/r₂`.

This catches the package that passes the staleness check — it shipped four
months ago — but has gone from monthly releases to one a year.

### Bus factor (weight 12)

1 maintainer → 1.0, 2 → 0.45, 3 → 0.2, 4+ → 0.

npm publishes the maintainer list. **PyPI's JSON API does not**, so for PyPI
this signal is `null` and its weight leaves the denominator entirely (see
[Unscorable signals](#unscorable-signals)). It is not assumed healthy.

### Version drift (weight 12)

Majors behind latest: 1 → 0.5, 2 → 0.8, 3+ → 1.0. Same major but not the exact
latest → 0.15.

For `0.x` releases the **minor** acts as the major, because semver itself says
`0.y` may break. `0.2.0` against a latest of `0.9.0` scores as seven majors
behind, not zero.

Requires a concrete version. A range like `>=1.0` pins nothing, so drift is
unscorable rather than guessed from the lower bound.

### The rest

- **License clarity (8)** — missing, `UNKNOWN`, `UNLICENSED`, `SEE LICENSE`. A
  dependency whose license you cannot identify is one you cannot ship.
- **Maturity (8)** — under 90 days old with fewer than 5 releases → 1.0. This is
  the shape a typosquat or a hallucinated package name has on first publish.
- **Source provenance (5)** — no repository URL means no way to audit, fork, or
  take over the package.

## Composition

```
score = round( 100 × Σ(valueᵢ × weightᵢ) / Σ(weightᵢ) )   over scorable signals
if deprecated: score = max(score, 80)
```

### Unscorable signals

When a registry does not expose an input, the signal's `value` is `null` and
**its weight is removed from the denominator** rather than being scored as 0.

This matters: scoring an unknown as healthy would make every PyPI package look
better than an equivalent npm one purely because PyPI hides its maintainer
list. Pinned by the "excludes unscorable signals from the weighting" test.

### Deprecation is an override, not a term

A maintainer writing "this package is deprecated" is ground truth. It is
applied as a **floor of 80** (grade F) and carries weight 0 in the average.

This started as a weighted signal at weight 40, and that was wrong. Hardly any
abandoned package is ever *formally* deprecated, so for the common case that
40 sat in the denominator contributing nothing to the numerator — capping a
genuinely dead package's score at roughly 45. `nose`, untouched since 2015 and
broken on modern Python, scored 45 ("Aging"). With deprecation moved out of the
average it scores 72 ("At risk"), which is the honest answer.

Pinned by the "rates a long-abandoned package that was never formally
deprecated as At risk" test.

## Grades

| Score | Grade | Verdict |
|---|---|---|
| 0–19 | A | Healthy |
| 20–39 | B | Watch |
| 40–59 | C | Aging |
| 60–79 | D | At risk |
| 80–100 | F | Critical |

## Portfolio score

One number for a whole manifest, via a **power mean** with exponent 4:

```
portfolio = round( ( Σ scoreᵢ⁴ / n )^(1/4) )
```

A plain arithmetic mean lets 200 healthy dependencies bury three abandoned
ones — precisely the failure this product exists to fix. The power mean pulls
the result toward the worst packages while still accounting for every one.

**This started as `0.4 × mean + 0.6 × p90` and a unit test killed it.** With 40
healthy dependencies and 4 rotten ones, the rotten ones sit *above* the 90th
percentile, so p90 read a healthy package and the portfolio score moved by 3
points. A percentile has a blind spot exactly where the product needs vision;
a power mean has none. Pinned by the "does not let a crowd of healthy packages
bury a few rotten ones" test.

Calibration checks, both tested:

- 200 healthy + 1 deprecated → ~21 (Watch), not Critical.
- 40 healthy + 4 critical → ~50 (Aging), not ~8.

Packages the user has **acknowledged** are excluded from the portfolio score
(they keep their own score and stay visible). Without that, a score containing
deliberate, accepted risk can never be driven to green, and a number that can
never be green gets ignored.

## Known limits

These are real and worth stating plainly.

1. **No importance weighting.** A rotting build-time formatter counts the same
   as a rotting crypto library. Bitrot cannot see how deeply you depend on
   something. Acknowledgements are the manual escape hatch.
2. **"Finished" software scores as stale.** Some packages are genuinely
   complete. A twelve-line utility with one maintainer and no release since
   2019 may be exactly right. The signals cannot distinguish "abandoned" from
   "done" — only a human can.
3. **No download counts.** `api.npmjs.org/downloads` would let the score weight
   blast radius, and is the most valuable next signal to add.
4. **No repository health.** Archived-on-GitHub, open issue counts and last
   commit date all live behind the GitHub API, which needs a token. The
   registry-only design keeps Bitrot dependency-free and unauthenticated.
5. **PyPI bus factor is invisible.** Not exposed by the JSON API.
6. **Latest ≠ best.** Drift assumes the newest release is the target. For a
   package that shipped a bad major, that is wrong.
