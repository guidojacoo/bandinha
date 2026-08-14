import { View, Text, ScrollView, StyleSheet, Alert } from "react-native";
import Constants from "expo-constants";
import { useAuth } from "../state/AuthContext";
import { api } from "../api/client";
import { Card, PrimaryButton } from "../components/ui";
import { lightTheme } from "../theme";

export function SettingsScreen() {
  const { user, logout } = useAuth();
  const apiBaseUrl = Constants.expoConfig?.extra?.apiBaseUrl ?? "http://localhost:3000";

  function confirmDelete() {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your account and all synced health data. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await api.post("/api/account/delete");
            await logout();
          },
        },
      ],
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <Card style={{ gap: 8 }}>
        <Text style={styles.sectionTitle}>Account</Text>
        <Text style={styles.line}><Text style={styles.bold}>Name:</Text> {user?.name ?? "—"}</Text>
        <Text style={styles.line}><Text style={styles.bold}>Email:</Text> {user?.email}</Text>
        <Text style={styles.line}><Text style={styles.bold}>Timezone:</Text> {user?.timezone}</Text>
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={styles.sectionTitle}>Privacy &amp; data</Text>
        <Text style={styles.body}>
          Your health data is never sent to third parties. To export a full copy of your data, open{" "}
          {apiBaseUrl}/settings on the H59 Health web dashboard while signed in.
        </Text>
      </Card>

      <PrimaryButton title="Log out" onPress={logout} />
      <Text style={styles.deleteLink} onPress={confirmDelete}>Delete account</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: lightTheme.bg },
  content: { padding: 20, gap: 16, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "700", color: lightTheme.text },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: lightTheme.text },
  line: { fontSize: 14, color: lightTheme.textMuted },
  bold: { fontWeight: "700", color: lightTheme.text },
  body: { fontSize: 13, color: lightTheme.textMuted, lineHeight: 19 },
  deleteLink: { textAlign: "center", color: lightTheme.bad, fontWeight: "600", fontSize: 13 },
});
