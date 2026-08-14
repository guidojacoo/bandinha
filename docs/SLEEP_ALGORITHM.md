# Sleep Score & Recovery Score

**Not a medical diagnostic.** Both scores are H59 Health's own product
decision about how to weigh device readings into one number — not a
QWatch Pro value (we don't have access to their algorithm, and wouldn't
trust it blindly if we did), not a clinical assessment, and not a
substitute for advice from an actual clinician. Every screen that shows
these numbers should carry that framing.

Implementation: [`packages/scoring`](../packages/scoring) — pure,
documented, unit-tested TypeScript functions. Nothing here talks to a
database or the network; given the same inputs, both always return the
same output, which is what makes them easy to tune and verify.

## Sleep Score (0-100)

`computeSleepScore()` in `packages/scoring/src/sleepScore.ts`. Weighted sum
of seven components:

| Component | Weight | What it measures |
|---|---:|---|
| Duration | 30 | Total sleep time vs. a 7-9h sweet spot |
| Continuity | 20 | Sleep efficiency (time asleep / time in bed) minus a penalty per extra awakening |
| Deep sleep | 15 | % of sleep in the deep stage vs. a 13-23% target band |
| REM sleep | 15 | % of sleep in REM vs. a 20-25% target band |
| Regularity | 10 | How consistent bedtime is vs. the last 7 nights (stdev in minutes) |
| Nocturnal HRV | 5 | This night's HRV vs. your own rolling baseline |
| Nocturnal resting HR | 5 | This night's resting HR vs. your own rolling baseline |

**Duration curve** — deliberately steep below 6h (a commonly-cited
"too little sleep" threshold), flat 100 across 7-9h, gentle taper above
9h (oversleeping isn't as bad as undersleeping, but isn't free either):

```
0min ───ramp──▶ 360min(55) ───ramp──▶ 420min(85) ───flat 100──▶ 540min ───ramp──▶ 660min(50)
```

**Deep/REM bands** — 100 inside the target range, `-5 points per
percentage-point` outside it in either direction (`bandScore` in
`sleepScore.ts`).

**Continuity** — `efficiency% - 6×max(0, awakenings-1)`. The first
awakening of the night isn't penalized (normal to stir once); each one
after that costs 6 points.

**Baseline-relative components (HRV, resting HR)** — scored against *your
own* rolling average, not a population norm: `50 + (value/baseline - 1) ×
sensitivity`, sign-flipped for resting HR since lower is better there. A
brand-new user with no baseline yet simply doesn't get this component
scored — see "missing data" below.

## Recovery Score (0-100)

`computeRecoveryScore()` in `packages/scoring/src/recoveryScore.ts`:

| Component | Weight | Source |
|---|---:|---|
| Sleep quality | 30 | Today's Sleep Score, unmodified |
| HRV | 25 | Same baseline-relative scoring as Sleep Score's HRV component |
| Resting heart rate | 15 | Same baseline-relative scoring, inverted |
| Regularity | 10 | Same bedtime-consistency score |
| Stress | 10 | `100 - averageStress` (device's own 0-100 stress scale) |
| Activity balance | 10 | How far yesterday's activity was from your 7-day average — very high *or* very low both cost a few points, `100 - |ratio-1|×40`, floored at 40 |

The aggregation that feeds this (14-day HRV/HR baselines, 7-day bedtime
stdev, activity-load ratio) lives in `apps/web/src/lib/recovery.ts`, shared
by `GET /api/recovery` and the dashboard Server Component so there's one
place that owns "how do we turn raw samples into these inputs" —
`packages/scoring` itself only owns "given these inputs, what's the score."

`compareToWeeklyAverage(todayScore, weeklyAvgScore)` produces the
"Tu recovery está 12% por encima de tu promedio semanal" figure shown on
the dashboard.

## Missing data doesn't crush the score

`weightedAverage()` in `packages/scoring/src/weightedAverage.ts` only
averages the components that are actually present, **renormalizing their
weights to sum to 100** instead of treating a missing component as 0. A
user in their first week (no 14-day HRV baseline yet) gets a score based on
duration/continuity/deep/REM only — proportionally weighted — not a score
artificially dragged down by an input that doesn't exist yet.

## Changing the weights

Every weight is a named constant (`SLEEP_SCORE_WEIGHTS`,
`RECOVERY_SCORE_WEIGHTS`) at the top of its file — change a number, run
`npm test --workspace packages/scoring`, done. The test suite
(`packages/scoring/test/`) encodes the *intent* ("a fragmented night scores
lower than a good one", "a new user without baselines still gets a
sensible score") rather than exact numbers, so reasonable recalibration
shouldn't break it.
