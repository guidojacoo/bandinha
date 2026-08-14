"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthLayout } from "@/components/AuthLayout";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to see your health data.">
      <form onSubmit={onSubmit} className="stack" style={{ gap: 14 }}>
        <label className="stack" style={{ gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Email</span>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Password</span>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p style={{ color: "var(--bad)", fontSize: 13 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 18 }}>
        No account yet? <Link href="/register" style={{ color: "var(--accent)", fontWeight: 600 }}>Create one</Link>
      </p>
    </AuthLayout>
  );
}
