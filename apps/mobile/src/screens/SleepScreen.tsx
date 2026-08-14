import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator, Pressable, useWindowDimensions } from "react-native";
import { api } from "../api/client";
import { ScoreRing } from "../components/ScoreRing";
import { Card, StatTile } from "../components/ui";
import { SleepTimeline } from "../components/SleepTimeline";
import { lightTheme } from "../theme";

interface StageSegment {
  stage: "light" | "deep" | "rem" | "awake";
  startAt: string;
  durationMin: number;
}
interface SleepSession {
  id: string;
  date: string;
  startAt: string;
  endAt: string;
  totalMinutes: number;
  sleepScore: number | null;
}
interface SleepDetail extends SleepSession {
  stages: StageSegment[];
}

function fmtDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function SleepScreen() {
  const { width } = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessions, setSessions] = useState<SleepSession[]>([]);
  const [detail, setDetail] = useState<SleepDetail | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { sessions } = await api.get<{ sessions: SleepSession[] }>("/api/sleep");
    setSessions(sessions);
    const date = selectedDate ?? sessions[0]?.date;
    if (date) {
      const { session } = await api.get<{ session: SleepDetail }>(`/api/sleep/${date}`);
      setDetail(session);
      setSelectedDate(date);
    }
    setLoading(false);
  }, [selectedDate]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectDate(date: string) {
    setSelectedDate(date);
    const { session } = await api.get<{ session: SleepDetail }>(`/api/sleep/${date}`);
    setDetail(session);
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={lightTheme.accent} />
      </View>
    );
  }

  if (!sessions.length || !detail) {
    return (
      <View style={styles.center}>
        <Text style={styles.emoji}>☾</Text>
        <Text style={styles.emptyTitle}>No sleep data yet</Text>
        <Text style={styles.emptyBody}>Wear the band overnight, then sync from the Devices tab.</Text>
      </View>
    );
  }

  const totals: Record<string, number> = { light: 0, deep: 0, rem: 0, awake: 0 };
  for (const s of detail.stages) totals[s.stage] = (totals[s.stage] ?? 0) + s.durationMin;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.title}>Sleep</Text>

      <Card style={{ gap: 16 }}>
        <View style={styles.detailHeader}>
          <ScoreRing score={detail.sleepScore ?? 0} label="Sleep Score" size={96} />
          <View style={{ gap: 2 }}>
            <Text style={styles.dateLabel}>{fmtDate(detail.date)}</Text>
            <Text style={styles.durationLabel}>
              {Math.floor(detail.totalMinutes / 60)}h {detail.totalMinutes % 60}m
            </Text>
            <Text style={styles.timeRange}>
              {fmtTime(detail.startAt)} → {fmtTime(detail.endAt)}
            </Text>
          </View>
        </View>
        <SleepTimeline segments={detail.stages} startAt={detail.startAt} endAt={detail.endAt} width={width - 72} />
        <View style={styles.grid}>
          <StatTile label="Deep" value={totals.deep ?? 0} unit="min" />
          <StatTile label="REM" value={totals.rem ?? 0} unit="min" />
          <StatTile label="Light" value={totals.light ?? 0} unit="min" />
          <StatTile label="Awake" value={totals.awake ?? 0} unit="min" />
        </View>
      </Card>

      <Text style={styles.sectionTitle}>Recent nights</Text>
      <Card style={{ padding: 4 }}>
        {sessions.map((s) => (
          <Pressable key={s.id} onPress={() => selectDate(s.date)} style={[styles.nightRow, s.date === selectedDate && styles.nightRowActive]}>
            <Text style={styles.nightDate}>{fmtDate(s.date)}</Text>
            <Text style={styles.nightDuration}>
              {Math.floor(s.totalMinutes / 60)}h {s.totalMinutes % 60}m
            </Text>
            <Text style={[styles.nightScore, { color: scoreColor(s.sleepScore ?? 0) }]}>{s.sleepScore ?? "–"}</Text>
          </Pressable>
        ))}
      </Card>
    </ScrollView>
  );
}

function scoreColor(score: number): string {
  if (score >= 75) return lightTheme.good;
  if (score >= 50) return lightTheme.warn;
  return lightTheme.bad;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: lightTheme.bg },
  content: { padding: 20, gap: 18, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10, backgroundColor: lightTheme.bg },
  emoji: { fontSize: 40 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: lightTheme.text },
  emptyBody: { fontSize: 14, color: lightTheme.textMuted, textAlign: "center" },
  title: { fontSize: 22, fontWeight: "700", color: lightTheme.text },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: lightTheme.textMuted },
  detailHeader: { flexDirection: "row", alignItems: "center", gap: 16 },
  dateLabel: { fontSize: 13, color: lightTheme.textMuted },
  durationLabel: { fontSize: 20, fontWeight: "700", color: lightTheme.text },
  timeRange: { fontSize: 13, color: lightTheme.textMuted },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  nightRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 14, borderRadius: 12 },
  nightRowActive: { backgroundColor: lightTheme.accentSoft },
  nightDate: { fontSize: 14, fontWeight: "600", color: lightTheme.text },
  nightDuration: { fontSize: 13, color: lightTheme.textMuted },
  nightScore: { fontSize: 14, fontWeight: "700" },
});
