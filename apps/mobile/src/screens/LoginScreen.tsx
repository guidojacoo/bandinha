import { useState } from "react";
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useAuth, ApiError } from "../state/AuthContext";
import { PrimaryButton } from "../components/ui";
import { lightTheme } from "../theme";
import type { AuthStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<AuthStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Text style={styles.logo}>🩺 H59 Health</Text>
      <Text style={styles.title}>Welcome back</Text>
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
        placeholder="Password"
        placeholderTextColor={lightTheme.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton title={loading ? "Signing in…" : "Sign in"} onPress={onSubmit} disabled={loading} />
      <Text style={styles.link} onPress={() => navigation.navigate("Register")}>
        No account yet? Create one
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
