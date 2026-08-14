import { useState } from "react";
import { View, Text, ScrollView, StyleSheet, Alert } from "react-native";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import { useDevices } from "../state/DeviceContext";
import { Card, Pill, PrimaryButton } from "../components/ui";
import { lightTheme } from "../theme";
import type { MainTabParamList, RootStackParamList } from "../navigation/RootNavigator";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Devices">,
  NativeStackScreenProps<RootStackParamList>
>;

export function DevicesScreen({ navigation }: Props) {
  const { devices, refresh } = useDevices();
  const [removingId, setRemovingId] = useState<string | null>(null);

  function confirmRemove(id: string, name: string) {
    Alert.alert("Remove device?", `This deletes ${name}'s synced health data too.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setRemovingId(id);
          await api.delete(`/api/devices/${id}`);
          await refresh();
          setRemovingId(null);
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Devices</Text>

      {devices.map((d) => (
        <Card key={d.id} style={{ gap: 10 }}>
          <View style={styles.row}>
            <Text style={styles.deviceName}>{d.name}</Text>
          </View>
          <Text style={styles.hint}>
            🔋 {d.batteryLevel != null ? `${d.batteryLevel}%` : "unknown"} · last sync{" "}
            {d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "never"}
          </Text>
          <View style={styles.pillRow}>
            <Pill tone={d.hasVibrationMotor === true ? "good" : d.hasVibrationMotor === false ? "bad" : "muted"}>
              {`vibration: ${d.hasVibrationMotor === true ? "confirmed" : d.hasVibrationMotor === false ? "unsupported" : "unconfirmed"}`}
            </Pill>
          </View>
          <Text style={styles.removeLink} onPress={() => confirmRemove(d.id, d.name)}>
            {removingId === d.id ? "Removing…" : "Remove device"}
          </Text>
        </Card>
      ))}

      <PrimaryButton title="Pair a new H59" onPress={() => navigation.navigate("Pairing")} />

      <Card style={{ gap: 10 }}>
        <Text style={styles.helpTitle}>Before pairing</Text>
        <Text style={styles.hint}>
          Turn off Bluetooth on any other phone or computer currently connected to the band — it only
          talks to one device at a time. Wear the band so it's in range, then tap "Pair a new H59" above.
        </Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: lightTheme.bg },
  content: { padding: 20, gap: 14, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "700", color: lightTheme.text },
  row: { flexDirection: "row", justifyContent: "space-between" },
  deviceName: { fontSize: 16, fontWeight: "700", color: lightTheme.text },
  hint: { fontSize: 12, color: lightTheme.textMuted },
  pillRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  removeLink: { fontSize: 13, color: lightTheme.bad, fontWeight: "600" },
  helpTitle: { fontSize: 14, fontWeight: "700", color: lightTheme.text },
});
