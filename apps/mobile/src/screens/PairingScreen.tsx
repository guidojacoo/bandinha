import { useCallback, useState } from "react";
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { scanForH59, BleUnavailableError, type ScanResult } from "../ble/scan";
import { H59Connection } from "../ble/H59Connection";
import { syncDevice, type SyncProgress } from "../ble/sync";
import { api } from "../api/client";
import { useDevices } from "../state/DeviceContext";
import { PrimaryButton, Card } from "../components/ui";
import { lightTheme } from "../theme";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Stage = "idle" | "scanning" | "connecting" | "syncing" | "done" | "error";
type Props = NativeStackScreenProps<RootStackParamList, "Pairing">;

export function PairingScreen({ navigation }: Props) {
  const { refresh } = useDevices();
  const [stage, setStage] = useState<Stage>("idle");
  const [found, setFound] = useState<ScanResult[]>([]);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const startScan = useCallback(async () => {
    setStage("scanning");
    setError(null);
    setFound([]);
    try {
      await scanForH59((device) => setFound((prev) => (prev.some((d) => d.id === device.id) ? prev : [...prev, device])));
      setStage((s) => (s === "scanning" ? "idle" : s));
    } catch (e) {
      setStage("error");
      setError(describeError(e));
    }
  }, []);

  async function connectAndSync(device: ScanResult) {
    setStage("connecting");
    setError(null);
    try {
      const conn = await H59Connection.connect(device.id);
      const capabilities = await conn.readCapabilities();
      const battery = await conn.readBattery();
      await conn.disconnect();

      const { device: backendDevice } = await api.post<{ device: { id: string } }>("/api/devices", {
        bleId: device.id,
        name: device.name,
        capabilities,
        hasVibrationMotor: null,
      });

      setStage("syncing");
      const result = await syncDevice(device.id, backendDevice.id, setProgress);
      setSummary(
        `Synced ${result.daysSynced} day(s) of history. ` +
          (result.uploadedToBackend
            ? `Uploaded ${result.uploaded.healthSamples} readings.`
            : "No internet connection — data is cached on this phone and will upload automatically once you're back online."),
      );
      await refresh();
      setStage("done");
    } catch (e) {
      setStage("error");
      setError(describeError(e));
    }
  }

  if (stage === "done") {
    return (
      <View style={styles.screen}>
        <Text style={styles.emoji}>✅</Text>
        <Text style={styles.title}>All set!</Text>
        <Text style={styles.body}>{summary}</Text>
        <PrimaryButton title="Go to dashboard" onPress={() => navigation.goBack()} />
      </View>
    );
  }

  if (stage === "connecting" || stage === "syncing") {
    return (
      <View style={styles.screen}>
        <ActivityIndicator size="large" color={lightTheme.accent} />
        <Text style={styles.title}>{stage === "connecting" ? "Connecting…" : "Syncing…"}</Text>
        {progress && (
          <Text style={styles.body}>
            {progress.step} {progress.daysTotal > 0 ? `(${progress.daysDone}/${progress.daysTotal})` : ""}
          </Text>
        )}
      </View>
    );
  }

  if (stage === "error") {
    return (
      <View style={styles.screen}>
        <Text style={styles.emoji}>⚠️</Text>
        <Text style={styles.title}>Couldn't connect</Text>
        <Text style={styles.body}>{error}</Text>
        <PrimaryButton title="Try again" onPress={startScan} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Pair your H59</Text>
      <Text style={styles.body}>
        Wear the band and make sure it isn't connected to any other phone or QWatch Pro (it only talks to
        one device at a time).
      </Text>
      <PrimaryButton title={stage === "scanning" ? "Scanning…" : "Scan for my H59"} onPress={startScan} disabled={stage === "scanning"} />
      {stage === "scanning" && found.length === 0 && (
        <View style={styles.center}>
          <ActivityIndicator color={lightTheme.accent} />
          <Text style={styles.hint}>Looking for nearby H59 bands…</Text>
        </View>
      )}
      <FlatList
        data={found}
        keyExtractor={(d) => d.id}
        contentContainerStyle={{ gap: 10, marginTop: 12 }}
        renderItem={({ item }) => (
          <Pressable onPress={() => connectAndSync(item)}>
            <Card style={styles.deviceRow}>
              <Text style={styles.deviceName}>{item.name}</Text>
              <Text style={styles.hint}>{item.rssi != null ? `${item.rssi} dBm` : ""}</Text>
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}

function describeError(e: unknown): string {
  if (e instanceof BleUnavailableError) {
    switch (e.reason) {
      case "permissions":
        return "Bluetooth permission was denied. Enable it in Settings to pair your H59.";
      case "powered_off":
        return "Bluetooth is turned off. Turn it on and try again.";
      case "unauthorized":
        return "This app isn't authorized to use Bluetooth. Check Settings > Privacy.";
      default:
        return "Bluetooth isn't available on this device.";
    }
  }
  if (e && typeof e === "object" && "message" in e) {
    const msg = String((e as { message: unknown }).message);
    if (msg.toLowerCase().includes("timeout")) {
      return "Connection timed out. Make sure the band is worn, in range, and not connected to another phone.";
    }
    return msg;
  }
  return "Something went wrong. Please try again.";
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 14, backgroundColor: lightTheme.bg, justifyContent: "center" },
  center: { alignItems: "center", gap: 8, marginTop: 20 },
  emoji: { fontSize: 40, textAlign: "center" },
  title: { fontSize: 22, fontWeight: "700", color: lightTheme.text, textAlign: "center" },
  body: { fontSize: 14, color: lightTheme.textMuted, textAlign: "center" },
  hint: { fontSize: 12, color: lightTheme.textMuted },
  deviceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  deviceName: { fontSize: 15, fontWeight: "600", color: lightTheme.text },
});
