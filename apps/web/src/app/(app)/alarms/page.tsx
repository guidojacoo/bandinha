import { prisma } from "@h59/db";
import { requireSessionUser } from "@/lib/authServer";
import { AlarmsManager } from "@/components/AlarmsManager";

export default async function AlarmsPage() {
  const user = await requireSessionUser();
  const alarms = await prisma.alarm.findMany({ where: { userId: user.id }, orderBy: { time: "asc" } });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 style={{ margin: "0 0 4px", fontSize: 24 }}>Alarms</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", maxWidth: 640 }}>
          Every alarm currently fires as a notification from the H59 Health mobile app on your phone — this
          is guaranteed to work regardless of hardware. Writing an alarm directly onto the band's own clock
          is <strong>not yet available</strong>: the command is UNKNOWN (see docs/BLE_PROTOCOL.md); alarms
          will switch to "Runs on the band" automatically once that command is confirmed and shipped.
        </p>
      </div>
      <AlarmsManager
        initialAlarms={alarms.map((a) => ({ ...a, windowEndTime: a.windowEndTime ?? null }))}
      />
    </div>
  );
}
