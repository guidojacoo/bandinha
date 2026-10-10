import { redirect } from "next/navigation";
import { db } from "../../infra/db";
import { readSession } from "../../lib/auth";
import { login } from "../actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;

  let secretProblem: string | null = null;
  try {
    const session = await readSession();
    if (session) redirect("/");
  } catch (error) {
    // Surfaced rather than swallowed: a placeholder signing key on something
    // that can send mail as you is a hole, not a warning.
    secretProblem = error instanceof Error ? error.message : String(error);
  }

  const accounts = await db.user.count().catch(() => -1);

  return (
    <div className="center-page">
      <div className="card">
        <h1>Mercurio</h1>
        <p className="dim" style={{ fontSize: 13 }}>
          A sales agent that finds its own leads in open data and writes only what it can prove.
        </p>

        {secretProblem && <div className="banner bad" style={{ marginTop: 16 }}>{secretProblem}</div>}

        {accounts === 0 && (
          <div className="banner warn" style={{ marginTop: 16 }}>
            No account exists yet. Run <strong>npm run setup</strong> to create one.
          </div>
        )}
        {accounts === -1 && (
          <div className="banner bad" style={{ marginTop: 16 }}>
            The database has not been created. Run <strong>npm run setup</strong>.
          </div>
        )}
        {params.error && <div className="banner bad" style={{ marginTop: 16 }}>That email and password do not match.</div>}

        <form action={login} style={{ marginTop: 20 }}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <button type="submit" style={{ width: "100%", justifyContent: "center" }}>Sign in</button>
        </form>
      </div>
    </div>
  );
}
