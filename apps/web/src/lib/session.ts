import { cookies } from "next/headers";
import { verifySessionToken } from "./jwt";

export const SESSION_COOKIE = "h59_session";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
  }
}

/** Web (cookie) and mobile (Authorization: Bearer) both resolve to the same userId check. */
export async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const result = await verifySessionToken(authHeader.slice(7));
    return result?.userId ?? null;
  }
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (!cookieToken) return null;
  const result = await verifySessionToken(cookieToken);
  return result?.userId ?? null;
}

export async function requireUserId(req: Request): Promise<string> {
  const userId = await getUserId(req);
  if (!userId) throw new UnauthorizedError();
  return userId;
}
