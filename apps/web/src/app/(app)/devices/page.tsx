import { prisma } from "@h59/db";
import { requireSessionUser } from "@/lib/authServer";
import { DeviceCard } from "@/components/DeviceCard";

export default async function DevicesPage() {
  const user = await requireSessionUser();
  const devices = await prisma.device.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Devices</h1>

      {devices.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          {devices.map((d) => (
            <DeviceCard
              key={d.id}
              device={{
                ...d,
                lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
                capabilities: d.capabilities as Record<string, boolean> | null,
              }}
            />
          ))}
        </div>
      )}

      <div className="card stack" style={{ padding: 22, gap: 14 }}>
        <strong>Pair a new H59</strong>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
          Bluetooth Low Energy only works from a phone, so pairing happens in the H59 Health mobile app —
          this web dashboard can only view devices already paired there.
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--text-muted)", display: "grid", gap: 6 }}>
          <li>Open the H59 Health app on your phone and sign in with this same account.</li>
          <li>Turn off Bluetooth on any other phone/computer currently paired with the band (it only talks to one device at a time).</li>
          <li>Go to Devices → Pair a new band, and wear the H59 so it's in range.</li>
          <li>Tap the H59 in the scan list, wait for "Connected" then "Synced" — it will show up here automatically.</li>
        </ol>
      </div>
    </div>
  );
}
