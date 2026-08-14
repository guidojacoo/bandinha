import type { ReactNode } from "react";
import { requireSessionUser } from "@/lib/authServer";
import { AppShell } from "@/components/AppShell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireSessionUser();
  return <AppShell userName={user.name ?? user.email}>{children}</AppShell>;
}
