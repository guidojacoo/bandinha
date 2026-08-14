import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authStore } from "../storage/authStore";
import { api, ApiError } from "../api/client";

interface User {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string, timezone: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = await authStore.getToken();
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const { user } = await api.get<{ user: User }>("/api/me");
        setUser(user);
      } catch {
        await authStore.clearToken();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      async login(email, password) {
        const res = await api.post<{ user: User; token: string }>("/api/auth/login", { email, password });
        await authStore.setToken(res.token);
        setUser(res.user);
      },
      async register(email, password, name, timezone) {
        const res = await api.post<{ user: User; token: string }>("/api/auth/register", {
          email, password, name, timezone,
        });
        await authStore.setToken(res.token);
        setUser(res.user);
      },
      async logout() {
        await authStore.clearToken();
        setUser(null);
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };
