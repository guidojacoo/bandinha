"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const isRegister = mode === "register";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          isRegister ? { email, password, name: name || undefined } : { email, password },
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" style={{ gap: 18 }} onSubmit={submit}>
      <div>
        <h1 style={{ fontSize: 22 }}>{isRegister ? "Create an account" : "Sign in"}</h1>
        <p className="small muted" style={{ marginTop: 6 }}>
          {isRegister
            ? "Scans are saved to your account so you can track rot over time."
            : "Welcome back."}
        </p>
      </div>

      {error && (
        <div className="alert" data-tone="error">
          {error}
        </div>
      )}

      {isRegister && (
        <div className="field">
          <label className="label" htmlFor="name">
            Name <span className="faint">(optional)</span>
          </label>
          <input
            id="name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          required
          minLength={isRegister ? 10 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isRegister ? "new-password" : "current-password"}
        />
        {isRegister && <span className="tiny faint">At least 10 characters.</span>}
      </div>

      <button className="btn" type="submit" disabled={busy}>
        {busy ? "Working…" : isRegister ? "Create account" : "Sign in"}
      </button>

      <p className="small muted" style={{ textAlign: "center" }}>
        {isRegister ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="link">
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account?{" "}
            <Link href="/register" className="link">
              Create one
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
