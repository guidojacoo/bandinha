import { requireSessionUser } from "@/lib/authServer";
import { AccountActions } from "@/components/AccountActions";
import { ThemeToggle } from "@/components/ThemeToggle";

export default async function SettingsPage() {
  const user = await requireSessionUser();

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 560 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Settings</h1>

      <div className="card stack" style={{ padding: 20, gap: 14 }}>
        <strong>Account</strong>
        <div className="stack" style={{ gap: 4, fontSize: 14 }}>
          <span><strong>Name:</strong> {user.name ?? "—"}</span>
          <span><strong>Email:</strong> {user.email}</span>
          <span><strong>Timezone:</strong> {user.timezone}</span>
          <span><strong>Member since:</strong> {user.createdAt.toLocaleDateString()}</span>
        </div>
      </div>

      <div className="card stack" style={{ padding: 20, gap: 14 }}>
        <strong>Appearance</strong>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, color: "var(--text-muted)" }}>Theme</span>
          <ThemeToggle />
        </div>
      </div>

      <div className="card stack" style={{ padding: 20, gap: 14 }}>
        <strong>Privacy &amp; data</strong>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
          Your health data is never sent to third parties. The only opt-in exception is the AI insights
          feature, which is off by default and only sends an aggregated summary you can review — see
          docs/SECURITY.md.
        </p>
        <AccountActions />
      </div>
    </div>
  );
}
