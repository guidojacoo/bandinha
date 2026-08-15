import Link from "next/link";
import { Nav } from "@/components/Nav";
import { PackageCheck } from "@/components/PackageCheck";
import { PackageScoreCard } from "@/components/PackageScoreCard";
import { getUserId } from "@/lib/auth/session";
import { getPackage } from "@/lib/packageService";
import { WEIGHTS } from "@/lib/rot/signals";
import { scoreOne } from "@/lib/rot";

export const dynamic = "force-dynamic";

/**
 * The hero shows a real package scored live rather than a mockup.
 *
 * `colors` is the sharpest illustration of what Bitrot adds: it has no CVE and
 * is not deprecated, so every conventional scanner reports it as clean — while
 * being untouched for years behind a single publish account.
 */
const HERO_PACKAGE = "colors";

/**
 * The landing page must never wait on a third party.
 *
 * A warm cache answers in milliseconds, but the first request after the cache
 * expires would otherwise block on a live registry call with a 20s timeout.
 * The lookup is raced against a short budget; if it loses, the page renders
 * without the preview while the in-flight fetch still populates the cache for
 * the next visitor.
 */
const HERO_BUDGET_MS = 2500;

async function heroPreview() {
  try {
    const lookup = getPackage("npm", HERO_PACKAGE).catch(() => null);
    const result = await Promise.race([
      lookup,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HERO_BUDGET_MS)),
    ]);
    if (!result?.ok) return null;
    return { pkg: result.pkg, rot: scoreOne({ pkg: result.pkg, now: new Date() }) };
  } catch {
    // The landing page must render even if the registry or database is down.
    return null;
  }
}

const SIGNALS: Array<{ id: keyof typeof WEIGHTS; title: string; body: string }> = [
  {
    id: "deprecated",
    title: "Deprecated & yanked",
    body: "npm deprecation notices, PyPI yanks, and Inactive classifiers — the maintainer telling you directly, which no heuristic should outvote.",
  },
  {
    id: "staleness",
    title: "Staleness",
    body: "Time since the last release, on a curve. Six months is nothing. Four years is not.",
  },
  {
    id: "cadence",
    title: "Cadence collapse",
    body: "Releases this year against last year. Catches the package that shipped four months ago but went from monthly to never.",
  },
  {
    id: "busFactor",
    title: "Bus factor",
    body: "How many accounts can actually publish a fix. One is a single point of failure for everything downstream.",
  },
  {
    id: "drift",
    title: "Version drift",
    body: "How many majors behind you are — counting a 0.x minor as breaking, because semver says it is.",
  },
  {
    id: "license",
    title: "License clarity",
    body: "A dependency whose license you cannot identify is a dependency you cannot ship.",
  },
  {
    id: "immaturity",
    title: "Maturity",
    body: "Days-old packages with no track record — the shape a typosquat or a hallucinated package name has on first publish.",
  },
  {
    id: "provenance",
    title: "Source provenance",
    body: "No linked repository means no way to audit it, fork it, or take it over.",
  },
];

const MAX_WEIGHT = Math.max(...Object.values(WEIGHTS));

export default async function LandingPage() {
  const [userId, preview] = await Promise.all([getUserId(), heroPreview()]);

  return (
    <>
      <Nav />

      <main>
        {/* ------------------------------------------------------- hero */}
        <section className="glow">
          <div className="container" style={{ padding: "72px 24px 64px" }}>
            <div className="hero-grid">
              <div>
                <span className="badge" data-tone="warn">
                  Snyk Advisor shut down · January 2026
                </span>

                <h1
                  style={{
                    fontSize: "clamp(33px, 4.8vw, 52px)",
                    marginTop: 20,
                    lineHeight: 1.04,
                  }}
                >
                  Your scanner finds CVEs.
                  <br />
                  <span style={{ color: "var(--accent)" }}>Bitrot finds the other half.</span>
                </h1>

                <p className="muted" style={{ fontSize: 17.5, marginTop: 20, maxWidth: 520 }}>
                  The dependency that hurts you next probably has no CVE. It has a maintainer who
                  stopped answering in 2021, one publish account, and a version you are four majors
                  behind. Bitrot scores that risk from live npm and PyPI registry data.
                </p>

                <div className="row" style={{ gap: 11, marginTop: 28, flexWrap: "wrap" }}>
                  <Link href={userId ? "/scan" : "/register"} className="btn">
                    Scan a manifest
                  </Link>
                  <Link href="/check" className="btn btn-secondary">
                    Check one package
                  </Link>
                </div>
                <p className="tiny faint" style={{ marginTop: 12 }}>
                  Single-package checks need no account.
                </p>
              </div>

              {preview && (
                <div className="stack" style={{ gap: 9 }}>
                  <div className="row tiny faint" style={{ gap: 7 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--grade-a)",
                        flex: "none",
                      }}
                    />
                    Live from the registry, scored just now
                  </div>
                  <PackageScoreCard pkg={preview.pkg} rot={preview.rot} compact />
                  <p className="tiny faint" style={{ lineHeight: 1.5 }}>
                    No CVE. Not deprecated. Every conventional scanner calls this clean.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- problem */}
        <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-inset)" }}>
          <div className="container" style={{ padding: "68px 24px" }}>
            <h2 style={{ fontSize: "clamp(22px, 3vw, 29px)", maxWidth: 640 }}>
              Lifecycle risk is the half of supply-chain risk that scanners structurally cannot see.
            </h2>
            <p className="muted" style={{ marginTop: 14, maxWidth: 660 }}>
              A CVE scanner answers &ldquo;is there a published vulnerability in this version?&rdquo;
              That is a good question. It is not the question that explains why an upgrade is
              suddenly a three-week project.
            </p>

            <div className="grid-3" style={{ marginTop: 34 }}>
              <Stat
                figure="48.5%"
                label="of production dependencies carry lifecycle risk"
                source="2026 analysis of ~16,000 packages across ~100 organisations"
              />
              <Stat
                figure="20%+"
                label="of the top 50,000 npm packages are deprecated"
                source="npm registry research, 2026"
              />
              <Stat
                figure="2.1B"
                label="deprecated packages downloaded from npm weekly"
                source="Registry download analysis, 2026"
              />
            </div>

            <div className="card" style={{ marginTop: 30, maxWidth: 740 }}>
              <p className="small muted" style={{ margin: 0 }}>
                <strong style={{ color: "var(--text)" }}>The gap is fresh.</strong> Snyk Advisor —
                the free &ldquo;paste a package name, is it healthy?&rdquo; check most developers
                reached for — went offline in January 2026. The workflow it served did not move
                anywhere in particular. Bitrot rebuilds that check, and then does what Advisor never
                did: runs it across your whole manifest and ranks the results.
              </p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ what it scores */}
        <section className="container" style={{ padding: "68px 24px" }}>
          <div style={{ maxWidth: 620 }}>
            <h2 style={{ fontSize: "clamp(22px, 3vw, 29px)" }}>What goes into a score</h2>
            <p className="muted" style={{ marginTop: 12 }}>
              Eight signals, each weighted, each explained in plain language on every result. A
              signal the registry cannot answer is dropped from the weighting — never quietly scored
              as healthy.
            </p>
          </div>

          <div className="grid-2" style={{ marginTop: 30 }}>
            {SIGNALS.map((signal) => {
              const weight = WEIGHTS[signal.id];
              const isOverride = weight === 0;
              return (
                <div key={signal.id} className="card card-tight card-hover">
                  <div className="spread" style={{ gap: 10, alignItems: "baseline" }}>
                    <h3 style={{ fontSize: 14.5 }}>{signal.title}</h3>
                    <span className="tiny faint mono tnum">
                      {isOverride ? "override" : `weight ${weight}`}
                    </span>
                  </div>

                  <div className="signal-track" style={{ width: isOverride ? "100%" : `${(weight / MAX_WEIGHT) * 100}%`, marginTop: 10 }}>
                    <div
                      className="signal-fill"
                      style={{
                        width: "100%",
                        background: isOverride ? "var(--grade-f)" : "var(--accent)",
                        opacity: isOverride ? 0.85 : 0.7,
                      }}
                    />
                  </div>

                  <p className="small muted" style={{ marginTop: 11 }}>
                    {signal.body}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------------- live check */}
        <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-inset)" }}>
          <div className="container-narrow" style={{ padding: "68px 24px" }}>
            <div style={{ textAlign: "center", marginBottom: 22 }}>
              <h2 style={{ fontSize: "clamp(21px, 3vw, 27px)" }}>Try it on something real</h2>
              <p className="muted small" style={{ marginTop: 9 }}>
                Live registry data. No signup, no sample data.
              </p>
            </div>
            <PackageCheck />
          </div>
        </section>

        {/* ------------------------------------------------------- honesty */}
        <section className="container" style={{ padding: "60px 24px" }}>
          <div className="card" style={{ maxWidth: 740 }}>
            <h2 style={{ fontSize: 19 }}>What a rot score is not</h2>
            <p className="small muted" style={{ marginTop: 12 }}>
              A high score is not a verdict that a package is bad. Some packages are genuinely
              finished: a twelve-line utility with one maintainer and no release since 2019 may be
              exactly right for the job. Bitrot measures lifecycle signals, not importance or
              quality, and it cannot see how deeply you depend on something.
            </p>
            <p className="small muted" style={{ marginTop: 12 }}>
              That is why every finding can be acknowledged. An acknowledged package stays visible
              with its score intact but drops out of your portfolio number — so the score stays
              something a team can actually drive to green, instead of a permanent red badge
              everyone learns to ignore.
            </p>
          </div>
        </section>

        {/* ----------------------------------------------------------- cta */}
        <section className="container" style={{ padding: "10px 24px 88px" }}>
          <div
            className="card"
            style={{
              textAlign: "center",
              padding: "48px 26px",
              background: "linear-gradient(180deg, var(--bg-overlay), var(--bg-raised))",
            }}
          >
            <h2 style={{ fontSize: "clamp(21px, 3vw, 27px)" }}>Point it at a real manifest</h2>
            <p className="muted" style={{ maxWidth: 460, margin: "12px auto 0" }}>
              Paste a <code className="mono">package.json</code>,{" "}
              <code className="mono">package-lock.json</code> or{" "}
              <code className="mono">requirements.txt</code> and get a ranked list of what to deal
              with first.
            </p>
            <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
              <Link href={userId ? "/scan" : "/register"} className="btn">
                {userId ? "New scan" : "Create an account"}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer style={{ borderTop: "1px solid var(--border)" }}>
        <div className="container spread tiny faint" style={{ padding: "26px 24px" }}>
          <span>Bitrot — dependency lifecycle risk, scored from public registry metadata.</span>
          <span className="row" style={{ gap: 16 }}>
            <Link href="/check" className="link tiny">
              Check a package
            </Link>
            <a
              href="https://registry.npmjs.org"
              className="link tiny"
              rel="noreferrer noopener"
              target="_blank"
            >
              Data: npm
            </a>
            <a href="https://pypi.org" className="link tiny" rel="noreferrer noopener" target="_blank">
              PyPI
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}

function Stat({ figure, label, source }: { figure: string; label: string; source: string }) {
  return (
    <div className="card card-tight card-hover">
      <div
        className="tnum"
        style={{ fontSize: 31, fontWeight: 680, letterSpacing: "-0.035em", color: "var(--accent)" }}
      >
        {figure}
      </div>
      <div className="small" style={{ marginTop: 6 }}>
        {label}
      </div>
      <div className="tiny faint" style={{ marginTop: 9 }}>
        {source}
      </div>
    </div>
  );
}
