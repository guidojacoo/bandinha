"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * A deliberately realistic legacy manifest: packages that are genuinely
 * deprecated or abandoned on the real registry, mixed with healthy ones, so
 * the sample scan produces a real spread instead of a uniform result.
 */
const SAMPLE_PACKAGE_JSON = `{
  "name": "legacy-service",
  "version": "2.4.0",
  "dependencies": {
    "express": "^4.17.1",
    "request": "^2.88.2",
    "moment": "^2.29.1",
    "lodash": "^4.17.20",
    "colors": "^1.4.0",
    "left-pad": "^1.3.0",
    "body-parser": "^1.19.0",
    "node-uuid": "^1.4.8",
    "react": "^17.0.2"
  },
  "devDependencies": {
    "istanbul": "^0.4.5",
    "typescript": "^5.6.3"
  }
}`;

const SAMPLE_REQUIREMENTS = `# legacy python service
requests==2.28.1
flask==2.2.2
nose==1.3.7
distribute==0.7.3
sqlalchemy>=1.4
pytz==2022.1
`;

export function ScanForm() {
  const router = useRouter();
  const [manifest, setManifest] = useState("");
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest, filename: filename || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Scan failed.");
        return;
      }
      router.push(`/scans/${body.scanId}`);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    setManifest(await file.text());
  }

  return (
    <form className="stack" style={{ gap: 18 }} onSubmit={submit}>
      {error && (
        <div className="alert" data-tone="error">
          {error}
        </div>
      )}

      <div className="spread">
        <div className="row tiny faint" style={{ gap: 7, flexWrap: "wrap" }}>
          <span>Load a sample</span>
          <button
            type="button"
            className="btn-chip"
            onClick={() => {
              setManifest(SAMPLE_PACKAGE_JSON);
              setFilename("package.json");
            }}
          >
            package.json
          </button>
          <button
            type="button"
            className="btn-chip"
            onClick={() => {
              setManifest(SAMPLE_REQUIREMENTS);
              setFilename("requirements.txt");
            }}
          >
            requirements.txt
          </button>
        </div>

        <label className="btn btn-secondary btn-sm" style={{ cursor: "pointer" }}>
          Upload file
          <input
            type="file"
            accept=".json,.txt,text/plain,application/json"
            onChange={onFile}
            style={{ display: "none" }}
          />
        </label>
      </div>

      <div className="field">
        <label className="label" htmlFor="manifest">
          Manifest contents
        </label>
        <textarea
          id="manifest"
          className="textarea"
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          placeholder={"Paste package.json, package-lock.json or requirements.txt…"}
          spellCheck={false}
          required
        />
        <span className="tiny faint">
          The format is detected from the contents. Nothing but dependency names and versions is
          read.
        </span>
      </div>

      <div className="field">
        <label className="label" htmlFor="filename">
          Label <span className="faint">(optional)</span>
        </label>
        <input
          id="filename"
          className="input"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          placeholder="e.g. api-server/package.json"
        />
      </div>

      <button className="btn" type="submit" disabled={busy || !manifest.trim()}>
        {busy ? "Resolving against the registry…" : "Run scan"}
      </button>
      {busy && (
        <p className="tiny faint" style={{ textAlign: "center" }}>
          Each dependency is looked up live. A large lockfile can take a moment.
        </p>
      )}
    </form>
  );
}
