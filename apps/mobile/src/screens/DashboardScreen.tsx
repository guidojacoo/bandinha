import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import { api } from "../api/client";
import { useAuth } from "../state/AuthContext";
import { useDevices } from "../state/DeviceContext";
import { ScoreRing } from "../components/ScoreRing";
import { StatTile, PrimaryButton } from "../components/ui";
import { lightTheme } from "../theme";
import type { MainTabParamList } from "../navigation/RootNavigator";

type Props = BottomTabScreenProps<MainTabParamList, "Dashboard">;

interface HealthSample {
  ts: string;
  metric: string;
  value: number;
}
interface SleepSession {
  date: string;
  totalMinutes: number;
  sleepScore: number | null;
}
interface RecoveryResponse {
  available: boolean;
  recovery?: { score: number; comparedToWeeklyAvgPct: number | null };
  reason?: string;
}

function latestOf(samples: HealthSample[], metric: string): number | null {
  const match = samples.filter((s) => s.metric === metric).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  return match ? match.value : null;
}

export function DashboardScreen({ navigation }: Props) {
  const { user } = useAuth();
  const { primaryDevice, loading: devicesLoading, refresh: refreshDevices } = useDevices();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [samples, setSamples] = useState<HealthSample[]>([]);
  const [today, setToday] = useState<SleepSession | null>(null);
  const [recovery, setRecovery] = useState<RecoveryResponse | null>(null);

  const load = useCallback(async () => {
    if (!primaryDevice) {
      setLoading(false);
      return;
    }
    const [health, sleep, rec] = await Promise.all([
      api.get<{ samples: HealthSample[] }>("/api/health?limit=200"),
      api.get<{ sessions: SleepSession[] }>("/api/sleep"),
      api.get<RecoveryResponse>("/api/recovery"),
    ]);
    setSamples(health.samples);
    setToday(sleep.sessions[0] ?? null);
    setRecovery(rec);
    setLoading(false);
  }, [primaryDevice]);

  useEffect(() => {
    load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await refreshDevices();
    await load();
    setRefreshing(false);
  }

  if (devicesLoading || loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={lightTheme.accent} />
      </View>
    );
  }

  if (!primaryDevice) {
    return (
      <View style={styles.center}>
        <Text style={styles.emoji}>📶</Text>
        <Text style={styles.emptyTitle}>No device connected yet</Text>
        <Text style={styles.emptyBody}>Pair your H59 to start seeing your health data here.</Text>
        <PrimaryButton title="Pair a device" onPress={() => navigation.navigate("Devices")} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.greeting}>Hi {user?.name?.split(" ")[0] ?? "there"} 👋</Text>
      <Text style={styles.subGreeting}>
        {primaryDevice.name} · {primaryDevice.lastSyncAt ? `synced ${new Date(primaryDevice.lastSyncAt).toLocaleString()}` : "not synced yet"}
      </Text>

      <View style={styles.scoreRow}>
        <ScoreRing score={today?.sleepScore ?? 0} label="Sleep Score" />
        <ScoreRing score={recovery?.available ? recovery.recovery!.score : 0} label="Recovery" />
      </View>
      {recovery?.available && recovery.recovery?.comparedToWeeklyAvgPct != null && (
        <Text style={styles.compare}>
          Your recovery is {recovery.recovery.comparedToWeeklyAvgPct >= 0 ? "+" : ""}
          {recovery.recovery.comparedToWeeklyAvgPct}% vs. your weekly average.
        </Text>
      )}

      <View style={styles.grid}>
        <StatTile icon="☾" label="Hours slept" value={today ? (today.totalMinutes / 60).toFixed(1) : "–"} unit="h" />
        <StatTile icon="♥" label="Heart rate" value={latestOf(samples, "heart_rate") ?? "–"} unit="bpm" />
        <StatTile icon="≈" label="HRV" value={latestOf(samples, "hrv") ?? "–"} unit="ms" />
        <StatTile icon="◯" label="SpO2" value={latestOf(samples, "spo2") ?? "–"} unit="%" />
        <StatTile icon="⚡" label="Stress" value={latestOf(samples, "stress") ?? "–"} unit="/100" />
        <StatTile icon="🔋" label="Battery" value={primaryDevice.batteryLevel ?? "–"} unit={primaryDevice.batteryLevel != null ? "%" : undefined} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: lightTheme.bg },
  content: { padding: 20, gap: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10, backgroundColor: lightTheme.bg },
  emoji: { fontSize: 40 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: lightTheme.text },
  emptyBody: { fontSize: 14, color: lightTheme.textMuted, textAlign: "center", marginBottom: 8 },
  greeting: { fontSize: 22, fontWeight: "700", color: lightTheme.text },
  subGreeting: { fontSize: 13, color: lightTheme.textMuted, marginTop: 2 },
  scoreRow: { flexDirection: "row", justifyContent: "center", gap: 32, marginTop: 12 },
  compare: { textAlign: "center", fontSize: 13, color: lightTheme.textMuted },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
});
