import type { ReactNode } from "react";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "radial-gradient(circle at 20% 20%, var(--accent-soft), transparent 60%), var(--bg)",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
        <div className="row" style={{ gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 26 }}>🩺</span>
          <strong style={{ fontSize: 18 }}>H59 Health</strong>
        </div>
        <h1 style={{ fontSize: 22, margin: "18px 0 4px" }}>{title}</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, margin: "0 0 22px" }}>{subtitle}</p>
        {children}
      </div>
    </div>
  );
}
