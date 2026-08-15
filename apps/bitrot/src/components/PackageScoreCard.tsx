import type { Ecosystem, RegistryPackage } from "@/lib/registry/types";
import type { RotResult } from "@/lib/rot/types";
import { GradeBadge, ScoreDial } from "./Grade";
import { SignalList } from "./SignalList";

function registryUrl(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "npm"
    ? `https://www.npmjs.com/package/${name}`
    : `https://pypi.org/project/${name}/`;
}

/** Pluralise a count with its noun. `1 maintainer`, not `1 maintainers`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface Props {
  pkg: RegistryPackage;
  rot: RotResult;
  /** Compact drops the signal breakdown — used for the landing-page preview. */
  compact?: boolean;
}

/**
 * Presentational only, so both the client-side lookup form and the
 * server-rendered landing preview render an identical card.
 */
export function PackageScoreCard({ pkg, rot, compact = false }: Props) {
  const facts = [
    plural(pkg.releaseCount, "release"),
    pkg.maintainerCount !== undefined ? plural(pkg.maintainerCount, "maintainer") : null,
    pkg.license ?? null,
    pkg.lastPublishAt ? `last release ${pkg.lastPublishAt.slice(0, 10)}` : null,
  ].filter((f): f is string => Boolean(f));

  return (
    <div className="card stack" style={{ gap: compact ? 16 : 22 }}>
      <div className="row" style={{ gap: 22, alignItems: "center", flexWrap: "wrap" }}>
        <ScoreDial score={rot.score} grade={rot.grade} size={compact ? 96 : 118} />

        <div className="stack" style={{ gap: 7, flex: "1 1 220px", minWidth: 0 }}>
          <div className="row" style={{ gap: 9 }}>
            <GradeBadge grade={rot.grade} />
            <span style={{ fontWeight: 640, fontSize: 17 }}>{rot.verdict}</span>
          </div>

          <a
            href={registryUrl(pkg.ecosystem, pkg.name)}
            target="_blank"
            rel="noreferrer noopener"
            className="mono small truncate link"
            style={{ display: "block", color: "var(--text)" }}
          >
            {pkg.name}
            <span className="muted">@{pkg.latestVersion}</span>
          </a>

          {pkg.description && (
            <p className="small muted" style={{ margin: 0 }}>
              {pkg.description}
            </p>
          )}

          <div className="row tiny faint" style={{ gap: 12, flexWrap: "wrap", marginTop: 2 }}>
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
        </div>
      </div>

      {rot.reasons.length > 0 ? (
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Why
          </div>
          <ul className="stack small" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
            {rot.reasons.slice(0, compact ? 3 : undefined).map((reason) => (
              <li key={reason} className="muted">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          No lifecycle risk signals fired — actively released, clearly licensed, and traceable to
          source.
        </p>
      )}

      {!compact && <SignalList signals={rot.signals} />}
    </div>
  );
}
