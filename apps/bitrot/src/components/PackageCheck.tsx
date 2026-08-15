"use client";

import { useState } from "react";
import type { Ecosystem, RegistryPackage } from "@/lib/registry/types";
import type { RotResult } from "@/lib/rot/types";
import { PackageScoreCard } from "./PackageScoreCard";

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
      // Each path segment is encoded separately so npm scopes (@babel/core)
      // keep their slash as a route separator.
      const path = trimmed.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`/api/package/${ecosystem}/${path}`);
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
          className="select"
          style={{ width: "auto", flex: "none" }}
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
          style={{ flex: "1 1 200px" }}
          placeholder={ecosystem === "npm" ? "e.g. request" : "e.g. nose"}
          value={name}
          autoFocus={autoFocus}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Package name"
        />
        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>

      <div className="row tiny faint" style={{ gap: 7, flexWrap: "wrap" }}>
        <span>Try</span>
        {EXAMPLES[ecosystem].map((example) => (
          <button
            key={example}
            type="button"
            className="btn-chip"
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
        <div className="alert" data-tone="error" role="alert">
          {error}
        </div>
      )}

      {busy && !result && <CheckSkeleton />}

      {result && <PackageScoreCard pkg={result.package} rot={result.rot} />}
    </div>
  );
}

/** Placeholder shaped like the real card, so the layout does not jump. */
function CheckSkeleton() {
  return (
    <div className="card row" style={{ gap: 22, alignItems: "center" }} aria-hidden="true">
      <div
        style={{
          width: 118,
          height: 118,
          borderRadius: "50%",
          border: "9px solid var(--bg-inset)",
          flex: "none",
        }}
      />
      <div className="stack" style={{ gap: 10, flex: "1 1 200px" }}>
        <div style={{ height: 15, width: "42%", background: "var(--bg-inset)", borderRadius: 6 }} />
        <div style={{ height: 12, width: "68%", background: "var(--bg-inset)", borderRadius: 6 }} />
        <div style={{ height: 12, width: "54%", background: "var(--bg-inset)", borderRadius: 6 }} />
      </div>
    </div>
  );
}
