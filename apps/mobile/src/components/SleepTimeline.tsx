import { View, Text, StyleSheet } from "react-native";
import Svg, { Rect, G } from "react-native-svg";
import { lightTheme } from "../theme";

interface Segment {
  stage: "light" | "deep" | "rem" | "awake";
  startAt: string;
  durationMin: number;
}

const STAGE_ORDER = ["awake", "rem", "light", "deep"] as const;
const STAGE_LABEL: Record<(typeof STAGE_ORDER)[number], string> = { awake: "Awake", rem: "REM", light: "Light", deep: "Deep" };
const STAGE_COLOR: Record<(typeof STAGE_ORDER)[number], string> = {
  awake: lightTheme.stageAwake,
  rem: lightTheme.stageRem,
  light: lightTheme.stageLight,
  deep: lightTheme.stageDeep,
};

export function SleepTimeline({ segments, startAt, endAt, width = 320 }: { segments: Segment[]; startAt: string; endAt: string; width?: number }) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const totalMs = Math.max(1, end - start);
  const rowHeight = 26;
  const gap = 5;
  const height = STAGE_ORDER.length * rowHeight + (STAGE_ORDER.length - 1) * gap;
  const labelWidth = 48;
  const chartWidth = width - labelWidth;

  return (
    <View style={{ flexDirection: "row" }}>
      <View style={{ width: labelWidth, height }}>
        {STAGE_ORDER.map((stage, i) => (
          <View key={stage} style={{ height: rowHeight, marginBottom: i < 3 ? gap : 0, justifyContent: "center" }}>
            <Text style={styles.rowLabel}>{STAGE_LABEL[stage]}</Text>
          </View>
        ))}
      </View>
      <Svg width={chartWidth} height={height}>
        {STAGE_ORDER.map((stage, rowIndex) => {
          const y = rowIndex * (rowHeight + gap);
          return (
            <G key={stage}>
              <Rect x={0} y={y} width={chartWidth} height={rowHeight} rx={6} fill={lightTheme.bgInset} />
              {segments
                .filter((s) => s.stage === stage)
                .map((s, i) => {
                  const segStart = new Date(s.startAt).getTime();
                  const x = ((segStart - start) / totalMs) * chartWidth;
                  const w = Math.max(2, ((s.durationMin * 60_000) / totalMs) * chartWidth);
                  return <Rect key={i} x={x} y={y} width={w} height={rowHeight} rx={5} fill={STAGE_COLOR[stage]} />;
                })}
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  rowLabel: { fontSize: 10, color: lightTheme.textMuted },
});
