"use client";

import { useState } from "react";
import type { Ecosystem, RegistryPackage } from "@/lib/registry/types";
import type { RotResult } from "@/lib/rot/types";
import { GradeBadge, RotMeter, ScoreDial } from "./Grade";

interface CheckResponse {
  package: RegistryPackage;
  rot: RotResult;
  cached: boolean;
}

const EXAMPLES: Record<Ecosystem, string[]> = {
  npm: ["request", "colors", "moment", "express"],
  pypi: ["nose", "distribute", "requests", "flask"],
};

export function PackageCheck({ autoFocus = false }: { autoFocus?: boolean }) {
  const [ecosystem, setEcosystem] = useState<Ecosystem>("npm");
  const [name, setName] = useState("");
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(target: string) {
    const trimmed = target.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/package/${ecosystem}/${trimmed.split("/").map(encodeURIComponent).join("/")}`);
      const body = await res.json();
      if (!res.ok) {
        setResult(null);
        setError(body.error ?? "Lookup failed.");
      } else {
        setResult(body as CheckResponse);
      }
    } catch {
      setResult(null);
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check(name);
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <select
          className="input"
          style={{ width: "auto", flex: "none", cursor: "pointer" }}
          value={ecosystem}
          onChange={(e) => {
            setEcosystem(e.target.value as Ecosystem);
            setResult(null);
            setError(null);
          }}
          aria-label="Registry"
        >
          <option value="npm">npm</option>
          <option value="pypi">PyPI</option>
        </select>
        <input
          className="input mono"
          style={{ flex: "1 1 220px" }}
          placeholder={ecosystem === "npm" ? "e.g. request" : "e.g. nose"}
          value={name}
          autoFocus={autoFocus}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
        />
        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>

      <div className="row tiny faint" style={{ gap: 8, flexWrap: "wrap" }}>
        <span>Try:</span>
        {EXAMPLES[ecosystem].map((example) => (
          <button
            key={example}
            type="button"
            className="btn btn-ghost tiny mono"
            style={{ padding: "2px 8px" }}
            onClick={() => {
              setName(example);
              void check(example);
            }}
          >
            {example}
          </button>
        ))}
      </div>

      {error && (
        <div className="alert" data-tone="error">
          {error}
        </div>
      )}

      {result && <CheckResult data={result} />}
    </div>
  );
}

function CheckResult({ data }: { data: CheckResponse }) {
  const { package: pkg, rot } = data;

  return (
    <div className="card stack" style={{ gap: 18 }}>
      <div className="row" style={{ gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <ScoreDial score={rot.score} grade={rot.grade} size={116} />

        <div className="stack" style={{ gap: 8, flex: "1 1 260px", minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <GradeBadge grade={rot.grade} />
            <span style={{ fontWeight: 620, fontSize: 17 }}>{rot.verdict}</span>
          </div>
          <div className="mono small truncate">
            {pkg.name}
            <span className="faint">@{pkg.latestVersion}</span>
          </div>
          {pkg.description && (
            <p className="small muted" style={{ margin: 0 }}>
              {pkg.description}
            </p>
          )}
          <div className="row tiny faint" style={{ gap: 14, flexWrap: "wrap" }}>
            <span>{pkg.releaseCount} releases</span>
            {pkg.maintainerCount !== undefined && <span>{pkg.maintainerCount} maintainers</span>}
            {pkg.license && <span>{pkg.license}</span>}
            {pkg.lastPublishAt && <span>last release {pkg.lastPublishAt.slice(0, 10)}</span>}
          </div>
        </div>
      </div>

      {rot.reasons.length > 0 ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="tiny faint" style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Why
          </div>
          <ul className="stack small" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
            {rot.reasons.map((reason) => (
              <li key={reason} className="muted">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          No lifecycle risk signals fired. Actively released, clearly licensed, and traceable to
          source.
        </p>
      )}

      <SignalTable rot={rot} />
    </div>
  );
}

export function SignalTable({ rot }: { rot: RotResult }) {
  return (
    <div className="stack" style={{ gap: 9 }}>
      <div className="tiny faint" style={{ letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Signals
      </div>
      <div className="stack" style={{ gap: 9 }}>
        {rot.signals.map((signal) => {
          return (
            <div key={signal.id} className="row" style={{ gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 120, flex: "none" }} className="small">
                {signal.label}
              </div>
              <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                <div className="tiny muted">{signal.detail}</div>
              </div>
              <div
                className="tiny mono faint"
                style={{ width: 74, flex: "none", textAlign: "right" }}
              >
                {signal.value === null
                  ? "n/a"
                  : signal.weight === 0
                    ? "override"
                    : `${Math.round(signal.value * 100)}%`}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tiny faint">
        Each signal is weighted; unscorable signals (<span className="mono">n/a</span>) are dropped
        from the weighting rather than counted as healthy.
      </div>
    </div>
  );
}

export { RotMeter };
