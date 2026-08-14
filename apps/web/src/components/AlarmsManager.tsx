"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Alarm {
  id: string;
  label: string;
  time: string;
  days: number[];
  enabled: boolean;
  vibration: boolean;
  nativeDeviceAlarm: boolean;
  windowEndTime: string | null;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function emptyForm() {
  return { label: "Alarm", time: "07:00", days: [1, 2, 3, 4, 5], vibration: true, smartWindow: false, windowEndTime: "07:30" };
}

export function AlarmsManager({ initialAlarms }: { initialAlarms: Alarm[] }) {
  const router = useRouter();
  const [alarms, setAlarms] = useState(initialAlarms);
  const [form, setForm] = useState<ReturnType<typeof emptyForm> | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggle(alarm: Alarm) {
    setAlarms((prev) => prev.map((a) => (a.id === alarm.id ? { ...a, enabled: !a.enabled } : a)));
    await fetch(`/api/alarms/${alarm.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !alarm.enabled }),
    });
  }

  async function remove(id: string) {
    setAlarms((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/alarms/${id}`, { method: "DELETE" });
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    const res = await fetch("/api/alarms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: form.label,
        time: form.time,
        days: form.days,
        vibration: form.vibration,
        windowEndTime: form.smartWindow ? form.windowEndTime : undefined,
      }),
    });
    setBusy(false);
    if (res.ok) {
      const { alarm } = await res.json();
      setAlarms((prev) => [...prev, alarm].sort((a, b) => a.time.localeCompare(b.time)));
      setForm(null);
      router.refresh();
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack" style={{ padding: 4 }}>
        {alarms.length === 0 && (
          <p style={{ padding: 20, color: "var(--text-muted)", fontSize: 14 }}>No alarms yet.</p>
        )}
        {alarms.map((a) => (
          <div key={a.id} className="row" style={{ justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <div className="stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8 }}>
                <strong style={{ fontSize: 20 }}>{a.time}</strong>
                {a.windowEndTime && <span className="pill pill-muted">smart · until {a.windowEndTime}</span>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{a.label}</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {a.days.length === 7 ? "Every day" : a.days.map((d) => DAY_LABELS[d]).join(" ")}
                </span>
              </div>
              <span className={`pill ${a.nativeDeviceAlarm ? "pill-good" : "pill-warn"}`} style={{ width: "fit-content" }}>
                {a.nativeDeviceAlarm ? "Runs on the band" : "Phone notification (band alarm not yet available)"}
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btn-ghost"
                aria-label={a.enabled ? "Disable" : "Enable"}
                onClick={() => toggle(a)}
                style={{ color: a.enabled ? "var(--good)" : "var(--text-muted)" }}
              >
                {a.enabled ? "On" : "Off"}
              </button>
              <button className="btn btn-danger" onClick={() => remove(a.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      {form ? (
        <div className="card stack" style={{ padding: 20, gap: 14 }}>
          <strong>New alarm</strong>
          <label className="stack" style={{ gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Label</span>
            <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label className="stack" style={{ gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Time</span>
            <input className="input" type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          </label>
          <div className="stack" style={{ gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Repeat</span>
            <div className="row" style={{ gap: 6 }}>
              {DAY_LABELS.map((label, i) => {
                const active = form.days.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    className="btn"
                    style={{
                      width: 36,
                      height: 36,
                      padding: 0,
                      borderRadius: "50%",
                      background: active ? "var(--accent)" : "var(--bg-inset)",
                      color: active ? "var(--accent-contrast)" : "var(--text-muted)",
                    }}
                    onClick={() =>
                      setForm({
                        ...form,
                        days: active ? form.days.filter((d) => d !== i) : [...form.days, i].sort(),
                      })
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.vibration} onChange={(e) => setForm({ ...form, vibration: e.target.checked })} />
            Vibrate
          </label>
          <label className="row" style={{ gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={form.smartWindow} onChange={(e) => setForm({ ...form, smartWindow: e.target.checked })} />
            Smart alarm — wake me any time between the two times, whichever is best for my sleep phase
          </label>
          {form.smartWindow && (
            <label className="stack" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Latest time</span>
              <input
                className="input"
                type="time"
                value={form.windowEndTime}
                onChange={(e) => setForm({ ...form, windowEndTime: e.target.value })}
              />
            </label>
          )}
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || form.days.length === 0}>
              {busy ? "Saving…" : "Save alarm"}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-primary" style={{ width: "fit-content" }} onClick={() => setForm(emptyForm())}>
          + Add alarm
        </button>
      )}
    </div>
  );
}
