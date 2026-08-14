import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TextInput, Pressable, Switch, ActivityIndicator } from "react-native";
import { api } from "../api/client";
import { Card, Pill, PrimaryButton } from "../components/ui";
import { lightTheme } from "../theme";

interface Alarm {
  id: string;
  label: string;
  time: string;
  days: number[];
  enabled: boolean;
  vibration: boolean;
  nativeDeviceAlarm: boolean;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

export function AlarmsScreen() {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("Alarm");
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { alarms } = await api.get<{ alarms: Alarm[] }>("/api/alarms");
    setAlarms(alarms);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(alarm: Alarm) {
    setAlarms((prev) => prev.map((a) => (a.id === alarm.id ? { ...a, enabled: !a.enabled } : a)));
    await api.put(`/api/alarms/${alarm.id}`, { enabled: !alarm.enabled });
  }

  async function remove(id: string) {
    setAlarms((prev) => prev.filter((a) => a.id !== id));
    await api.delete(`/api/alarms/${id}`);
  }

  async function save() {
    if (!days.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return;
    setSaving(true);
    const { alarm } = await api.post<{ alarm: Alarm }>("/api/alarms", { label, time, days, vibration: true });
    setAlarms((prev) => [...prev, alarm].sort((a, b) => a.time.localeCompare(b.time)));
    setSaving(false);
    setShowForm(false);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={lightTheme.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Alarms</Text>
      <Text style={styles.hint}>
        Alarms fire as phone notifications today — writing to the band's own clock isn't available yet
        (the command is unknown, see docs/BLE_PROTOCOL.md). This still works fully offline.
      </Text>

      {alarms.map((a) => (
        <Card key={a.id} style={{ gap: 8 }}>
          <View style={styles.row}>
            <View>
              <Text style={styles.time}>{a.time}</Text>
              <Text style={styles.hint}>{a.label} · {a.days.length === 7 ? "Every day" : a.days.map((d) => DAY_LABELS[d]).join(" ")}</Text>
            </View>
            <Switch value={a.enabled} onValueChange={() => toggle(a)} trackColor={{ true: lightTheme.accent }} />
          </View>
          <View style={styles.row}>
            <Pill tone={a.nativeDeviceAlarm ? "good" : "warn"}>{a.nativeDeviceAlarm ? "Runs on the band" : "Phone notification"}</Pill>
            <Text style={styles.deleteLink} onPress={() => remove(a.id)}>Delete</Text>
          </View>
        </Card>
      ))}

      {showForm ? (
        <Card style={{ gap: 12 }}>
          <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="Label" />
          <TextInput style={styles.input} value={time} onChangeText={setTime} placeholder="HH:MM" />
          <View style={styles.dayRow}>
            {DAY_LABELS.map((d, i) => {
              const active = days.includes(i);
              return (
                <Pressable
                  key={i}
                  onPress={() => setDays((prev) => (active ? prev.filter((x) => x !== i) : [...prev, i].sort()))}
                  style={[styles.dayButton, active && { backgroundColor: lightTheme.accent }]}
                >
                  <Text style={{ color: active ? lightTheme.accentContrast : lightTheme.textMuted, fontWeight: "700" }}>{d}</Text>
                </Pressable>
              );
            })}
          </View>
          <PrimaryButton title={saving ? "Saving…" : "Save alarm"} onPress={save} disabled={saving || !days.length} />
        </Card>
      ) : (
        <PrimaryButton title="+ Add alarm" onPress={() => setShowForm(true)} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: lightTheme.bg },
  content: { padding: 20, gap: 14, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: lightTheme.bg },
  title: { fontSize: 22, fontWeight: "700", color: lightTheme.text },
  hint: { fontSize: 12, color: lightTheme.textMuted },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  time: { fontSize: 22, fontWeight: "700", color: lightTheme.text },
  deleteLink: { fontSize: 13, color: lightTheme.bad, fontWeight: "600" },
  input: {
    borderWidth: 1, borderColor: lightTheme.border, backgroundColor: lightTheme.bgInset,
    borderRadius: 10, padding: 12, fontSize: 15, color: lightTheme.text,
  },
  dayRow: { flexDirection: "row", gap: 6 },
  dayButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: lightTheme.bgInset },
});
