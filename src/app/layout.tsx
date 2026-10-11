import type { Metadata } from "next";
import { readSession } from "../lib/auth";
import { logout } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mercurio",
  description: "A sales agent that runs on open data and a free model tier.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let session: Awaited<ReturnType<typeof readSession>> = null;
  try {
    session = await readSession();
  } catch {
    // A missing or placeholder AUTH_SECRET throws. The login page explains it;
    // the shell should still render rather than white-screening.
  }

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <span className="brand">
              <span className="brand-mark" aria-hidden />
              Mercurio
            </span>
            {session && (
              <nav>
                <a href="/">Campaigns</a>
                <a href="/queue">Queue</a>
                <a href="/sources">Sources</a>
                <a href="/learning">What&apos;s working</a>
                <a href="/billing">Billing</a>
                <a href="/suppressions">Suppressions</a>
              </nav>
            )}
            <span className="spacer" />
            {session && (
              <>
                <span className="who">{session.email}</span>
                <form action={logout}>
                  <button className="ghost" type="submit">Sign out</button>
                </form>
              </>
            )}
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
