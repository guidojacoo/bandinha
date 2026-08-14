export function StatTile({
  label,
  value,
  unit,
  hint,
  icon,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  icon?: string;
}) {
  return (
    <div className="card stack" style={{ padding: "16px 18px", gap: 6 }}>
      <div className="row" style={{ gap: 8, color: "var(--text-muted)", fontSize: 13, fontWeight: 600 }}>
        {icon && <span aria-hidden>{icon}</span>}
        <span>{label}</span>
      </div>
      <div className="row" style={{ alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>{value}</span>
        {unit && <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{unit}</span>}
      </div>
      {hint && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{hint}</span>}
    </div>
  );
}
