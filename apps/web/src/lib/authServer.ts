import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@h59/db";
import { verifySessionToken } from "./jwt";
import { SESSION_COOKIE } from "./session";

export async function getSessionUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = await verifySessionToken(token);
  if (!result) return null;
  return prisma.user.findUnique({ where: { id: result.userId } });
}

/** Use at the top of any Server Component page under the dashboard. */
export async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}
