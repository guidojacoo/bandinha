import Link from "next/link";
import { Nav } from "@/components/Nav";
import { PackageCheck } from "@/components/PackageCheck";
import { getUserId } from "@/lib/auth/session";

const SIGNALS = [
  {
    title: "Deprecated & yanked",
    body: "npm deprecation notices and PyPI yanks and Inactive classifiers — the maintainer telling you directly, which no heuristic should outvote.",
  },
  {
    title: "Staleness",
    body: "Time since the last release, on a curve. Six months is nothing. Four years is not.",
  },
  {
    title: "Cadence collapse",
    body: "Releases in the last year against the year before. Catches the package that shipped four months ago but went from monthly to never.",
  },
  {
    title: "Bus factor",
    body: "How many accounts can actually publish a fix. One is a single point of failure for everything downstream.",
  },
  {
    title: "Version drift",
    body: "How many major versions behind you are — counting a 0.x minor as breaking, because semver says it is.",
  },
  {
    title: "License clarity",
    body: "A dependency whose license you cannot identify is a dependency you cannot ship.",
  },
  {
    title: "Provenance",
    body: "No linked source repository means no way to audit it, fork it, or take it over.",
  },
  {
    title: "Immaturity",
    body: "Days-old packages with no track record — the shape a typosquat or a hallucinated package name has on first publish.",
  },
];

export default async function LandingPage() {
  const userId = await getUserId();

  return (
    <>
      <Nav />

      <main>
        {/* ------------------------------------------------------- hero */}
        <section className="container" style={{ padding: "76px 24px 60px" }}>
          <div style={{ maxWidth: 720 }}>
            <span className="badge" data-tone="warn">
              Snyk Advisor shut down in January 2026
            </span>
            <h1
              style={{
                fontSize: "clamp(34px, 5.4vw, 54px)",
                marginTop: 20,
                lineHeight: 1.06,
                letterSpacing: "-0.035em",
              }}
            >
              Your scanner finds CVEs.
              <br />
              <span style={{ color: "var(--accent)" }}>Bitrot finds the other half.</span>
            </h1>
            <p className="muted" style={{ fontSize: 18, marginTop: 20, maxWidth: 620 }}>
              The dependency that will hurt you next probably has no CVE. It has a maintainer who
              stopped answering in 2021, one publish account, and a version you are four majors
              behind. Bitrot scores that risk from live npm and PyPI registry data.
            </p>

            <div className="row" style={{ gap: 12, marginTop: 28, flexWrap: "wrap" }}>
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
        </section>

        {/* -------------------------------------------------- live check */}
        <section className="container" style={{ paddingBottom: 72 }}>
          <div className="card" style={{ padding: 26 }}>
            <div className="spread" style={{ marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 19 }}>Try it on something real</h2>
                <p className="small muted" style={{ marginTop: 5 }}>
                  Live data, straight from the registry. No signup, no sample data.
                </p>
              </div>
            </div>
            <PackageCheck />
          </div>
        </section>

        {/* ----------------------------------------------------- problem */}
        <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-inset)" }}>
          <div className="container" style={{ padding: "64px 24px" }}>
            <h2 style={{ fontSize: 26, maxWidth: 620 }}>
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

            <div className="card" style={{ marginTop: 34, maxWidth: 720 }}>
              <p className="small muted" style={{ margin: 0 }}>
                <strong style={{ color: "var(--text)" }}>The gap is fresh.</strong> Snyk Advisor —
                the free &ldquo;paste a package name, is it healthy?&rdquo; check most developers
                reached for — went offline in January 2026. The workflow it served did not move
                anywhere in particular. Bitrot rebuilds that check, and then does the thing Advisor
                never did: runs it across your whole manifest and ranks the results.
              </p>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------- what it scores */}
        <section className="container" style={{ padding: "64px 24px" }}>
          <h2 style={{ fontSize: 26 }}>What goes into a score</h2>
          <p className="muted" style={{ marginTop: 12, maxWidth: 620 }}>
            Eight signals, each weighted, each explained in plain language on every result. A signal
            the registry cannot answer is dropped from the weighting — never quietly scored as
            healthy.
          </p>

          <div className="grid-2" style={{ marginTop: 30 }}>
            {SIGNALS.map((signal) => (
              <div key={signal.title} className="card card-tight">
                <h3 style={{ fontSize: 15 }}>{signal.title}</h3>
                <p className="small muted" style={{ marginTop: 7 }}>
                  {signal.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------- honesty */}
        <section style={{ borderTop: "1px solid var(--border)" }}>
          <div className="container" style={{ padding: "56px 24px" }}>
            <div className="card" style={{ maxWidth: 720 }}>
              <h2 style={{ fontSize: 19 }}>What a rot score is not</h2>
              <p className="small muted" style={{ marginTop: 12 }}>
                A high score is not a verdict that a package is bad. Some packages are genuinely
                finished: a twelve-line utility with one maintainer and no release since 2019 may be
                exactly right for the job. Bitrot measures lifecycle signals, not importance or
                quality, and it cannot see how deeply you depend on something.
              </p>
              <p className="small muted" style={{ marginTop: 12 }}>
                That is why every finding can be acknowledged. An acknowledged package stays visible
                with its score intact, but drops out of your portfolio number — so the score stays
                something a team can actually drive to green, instead of a permanent red badge
                everyone learns to ignore.
              </p>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- cta */}
        <section className="container" style={{ padding: "20px 24px 90px" }}>
          <div
            className="card"
            style={{
              textAlign: "center",
              padding: "46px 26px",
              background: "linear-gradient(180deg, var(--bg-raised), var(--bg-inset))",
            }}
          >
            <h2 style={{ fontSize: 25 }}>Point it at a real manifest</h2>
            <p className="muted" style={{ marginTop: 12, maxWidth: 470, margin: "12px auto 0" }}>
              Paste a <code className="mono">package.json</code>,{" "}
              <code className="mono">package-lock.json</code> or{" "}
              <code className="mono">requirements.txt</code> and get a ranked list of what to deal
              with first.
            </p>
            <div className="row" style={{ justifyContent: "center", marginTop: 26 }}>
              <Link href={userId ? "/scan" : "/register"} className="btn">
                {userId ? "New scan" : "Create an account"}
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer style={{ borderTop: "1px solid var(--border)" }}>
        <div
          className="container spread tiny faint"
          style={{ padding: "26px 24px" }}
        >
          <span>
            Bitrot — dependency lifecycle risk, scored from public registry metadata.
          </span>
          <span className="row" style={{ gap: 16 }}>
            <Link href="/check" className="nav-link tiny" style={{ padding: 0 }}>
              Check a package
            </Link>
            <a
              href="https://registry.npmjs.org"
              className="nav-link tiny"
              style={{ padding: 0 }}
              rel="noreferrer noopener"
              target="_blank"
            >
              Data: npm
            </a>
            <a
              href="https://pypi.org"
              className="nav-link tiny"
              style={{ padding: 0 }}
              rel="noreferrer noopener"
              target="_blank"
            >
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
    <div className="card card-tight">
      <div
        style={{
          fontSize: 30,
          fontWeight: 680,
          letterSpacing: "-0.03em",
          color: "var(--accent)",
        }}
      >
        {figure}
      </div>
      <div className="small" style={{ marginTop: 6 }}>
        {label}
      </div>
      <div className="tiny faint" style={{ marginTop: 8 }}>
        {source}
      </div>
    </div>
  );
}
