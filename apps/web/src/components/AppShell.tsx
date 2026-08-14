import type { ReactNode } from "react";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";
import { LogoutButton } from "./LogoutButton";

export function AppShell({ userName, children }: { userName: string | null; children: ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", display: "flex" }}>
      <aside
        id="h59-sidebar"
        className="stack"
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          padding: "24px 16px",
          gap: 24,
          display: "none",
        }}
      >
        <div className="row" style={{ gap: 10, padding: "0 10px" }}>
          <span style={{ fontSize: 22 }}>🩺</span>
          <strong style={{ fontSize: 16 }}>H59 Health</strong>
        </div>
        <NavLinks variant="side" />
        <div className="stack" style={{ marginTop: "auto", gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between", padding: "0 10px" }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{userName}</span>
            <ThemeToggle />
          </div>
          <LogoutButton />
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header
          id="h59-topbar"
          className="row"
          style={{
            justifyContent: "space-between",
            padding: "14px 20px",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          <div className="row" style={{ gap: 10 }}>
            <span style={{ fontSize: 20 }}>🩺</span>
            <strong>H59 Health</strong>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <ThemeToggle />
            <LogoutButton />
          </div>
        </header>

        <main id="h59-main" style={{ flex: 1, padding: "20px 20px 90px", maxWidth: 1100, width: "100%", margin: "0 auto" }}>
          {children}
        </main>

        <nav
          id="h59-bottomnav"
          className="row"
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "8px 8px calc(8px + env(safe-area-inset-bottom))",
            background: "var(--bg-elevated)",
            borderTop: "1px solid var(--border)",
          }}
        >
          <NavLinks variant="bottom" />
        </nav>
      </div>

      <style>{`
        @media (min-width: 900px) {
          #h59-sidebar { display: flex !important; }
          #h59-topbar { display: none !important; }
          #h59-bottomnav { display: none !important; }
          #h59-main { padding-bottom: 20px !important; }
        }
      `}</style>
    </div>
  );
}
