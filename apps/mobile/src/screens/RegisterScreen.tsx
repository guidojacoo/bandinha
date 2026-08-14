import { useState } from "react";
import { Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth, ApiError } from "../state/AuthContext";
import { PrimaryButton } from "../components/ui";
import { lightTheme } from "../theme";
import type { AuthStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<AuthStackParamList, "Register">;

export function RegisterScreen({ navigation }: Props) {
  const { register } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setLoading(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await register(email, password, name, timezone);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Text style={styles.logo}>🩺 H59 Health</Text>
      <Text style={styles.title}>Create your account</Text>
      <TextInput style={styles.input} placeholder="Name" placeholderTextColor={lightTheme.textMuted} value={name} onChangeText={setName} />
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={lightTheme.textMuted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password (min. 8 characters)"
        placeholderTextColor={lightTheme.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton title={loading ? "Creating…" : "Create account"} onPress={onSubmit} disabled={loading} />
      <Text style={styles.link} onPress={() => navigation.navigate("Login")}>
        Already have an account? Sign in
      </Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 24, gap: 12, backgroundColor: lightTheme.bg },
  logo: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 8, color: lightTheme.text },
  input: {
    borderWidth: 1,
    borderColor: lightTheme.border,
    backgroundColor: lightTheme.bgInset,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: lightTheme.text,
  },
  error: { color: lightTheme.bad, fontSize: 13 },
  link: { textAlign: "center", color: lightTheme.accent, fontWeight: "600", marginTop: 8 },
});
