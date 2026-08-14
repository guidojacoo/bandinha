"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Device {
  id: string;
  name: string;
  bleId: string;
  firmwareVersion: string | null;
  hardwareVersion: string | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  lastSyncAt: string | null;
  hasVibrationMotor: boolean | null;
  capabilities: Record<string, boolean> | null;
}

export function DeviceCard({ device }: { device: Device }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!confirm(`Remove ${device.name}? This deletes its synced health data too.`)) return;
    setBusy(true);
    await fetch(`/api/devices/${device.id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  const caps = device.capabilities ? Object.entries(device.capabilities).filter(([, v]) => v) : [];

  return (
    <div className="card stack" style={{ padding: 20, gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="stack" style={{ gap: 2 }}>
          <strong style={{ fontSize: 16 }}>{device.name}</strong>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{device.bleId}</span>
        </div>
        <button className="btn btn-danger" onClick={remove} disabled={busy}>
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>

      <div className="row" style={{ gap: 16, flexWrap: "wrap", fontSize: 13, color: "var(--text-muted)" }}>
        <span>🔋 {device.batteryLevel != null ? `${device.batteryLevel}%${device.batteryCharging ? " (charging)" : ""}` : "unknown"}</span>
        <span>fw {device.firmwareVersion ?? "unknown"}</span>
        <span>last sync {device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : "never"}</span>
      </div>

      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {caps.map(([k]) => (
          <span key={k} className="pill pill-good">{k}</span>
        ))}
        <span className={`pill ${device.hasVibrationMotor === true ? "pill-good" : device.hasVibrationMotor === false ? "pill-bad" : "pill-muted"}`}>
          vibration: {device.hasVibrationMotor === true ? "confirmed" : device.hasVibrationMotor === false ? "not supported" : "unconfirmed"}
        </span>
      </div>
    </div>
  );
}
