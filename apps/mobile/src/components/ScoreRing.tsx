import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, G } from "react-native-svg";
import { lightTheme } from "../theme";

function colorFor(score: number): string {
  if (score >= 75) return lightTheme.good;
  if (score >= 50) return lightTheme.warn;
  return lightTheme.bad;
}

export function ScoreRing({ score, label, size = 120 }: { score: number; label: string; size?: number }) {
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, score)) / 100) * c;

  return (
    <View style={styles.container}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <G rotation="-90" originX={size / 2} originY={size / 2}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={lightTheme.bgInset} strokeWidth={stroke} fill="none" />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colorFor(score)}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${dash} ${c}`}
            strokeLinecap="round"
          />
        </G>
      </Svg>
      <View style={StyleSheet.absoluteFill}>
        <View style={styles.centerText}>
          <Text style={styles.scoreText}>{Math.round(score)}</Text>
        </View>
      </View>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", gap: 8 },
  centerText: { flex: 1, alignItems: "center", justifyContent: "center" },
  scoreText: { fontSize: 28, fontWeight: "700", color: lightTheme.text },
  label: { fontSize: 13, fontWeight: "600", color: lightTheme.textMuted },
});
