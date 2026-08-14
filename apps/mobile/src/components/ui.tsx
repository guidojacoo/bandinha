import { View, Text, StyleSheet, Pressable, type ViewProps } from "react-native";
import { lightTheme } from "../theme";

export function Card({ style, ...props }: ViewProps) {
  return <View style={[styles.card, style]} {...props} />;
}

export function StatTile({ label, value, unit, icon }: { label: string; value: string | number; unit?: string; icon?: string }) {
  return (
    <Card style={styles.tile}>
      <View style={styles.tileHeader}>
        {icon && <Text style={styles.icon}>{icon}</Text>}
        <Text style={styles.tileLabel}>{label}</Text>
      </View>
      <View style={styles.tileValueRow}>
        <Text style={styles.tileValue}>{value}</Text>
        {unit && <Text style={styles.tileUnit}>{unit}</Text>}
      </View>
    </Card>
  );
}

export function Pill({ children, tone = "muted" }: { children: string; tone?: "good" | "warn" | "bad" | "muted" }) {
  const colors: Record<string, [string, string]> = {
    good: [lightTheme.goodSoft, lightTheme.good],
    warn: ["#fbf1de", lightTheme.warn],
    bad: [lightTheme.badSoft, lightTheme.bad],
    muted: [lightTheme.bgInset, lightTheme.textMuted],
  };
  const [bg, fg] = colors[tone]!;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{children}</Text>
    </View>
  );
}

export function PrimaryButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, { opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: lightTheme.bgElevated,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: lightTheme.border,
    padding: 16,
  },
  tile: { flexBasis: "47%", flexGrow: 1, gap: 6 },
  tileHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  icon: { fontSize: 13 },
  tileLabel: { fontSize: 13, fontWeight: "600", color: lightTheme.textMuted },
  tileValueRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  tileValue: { fontSize: 24, fontWeight: "700", color: lightTheme.text },
  tileUnit: { fontSize: 12, color: lightTheme.textMuted },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: "flex-start" },
  pillText: { fontSize: 12, fontWeight: "700" },
  button: {
    backgroundColor: lightTheme.accent,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: { color: lightTheme.accentContrast, fontWeight: "700", fontSize: 15 },
});
