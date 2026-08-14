import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "./AuthContext";

export interface BackendDevice {
  id: string;
  bleId: string;
  name: string;
  firmwareVersion: string | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  lastSyncAt: string | null;
  hasVibrationMotor: boolean | null;
  capabilities: Record<string, boolean> | null;
}

interface DeviceContextValue {
  devices: BackendDevice[];
  primaryDevice: BackendDevice | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [devices, setDevices] = useState<BackendDevice[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setDevices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get<{ devices: BackendDevice[] }>("/api/devices");
      setDevices(res.devices);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<DeviceContextValue>(
    () => ({ devices, primaryDevice: devices[0] ?? null, loading, refresh }),
    [devices, loading, refresh],
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevices(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevices must be used within DeviceProvider");
  return ctx;
}
