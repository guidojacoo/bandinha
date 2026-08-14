import { SignJWT, jwtVerify } from "jose";
import { requireEnv } from "./env";

function secretKey(): Uint8Array {
  return new TextEncoder().encode(requireEnv("AUTH_SECRET"));
}

/**
 * The same signed JWT backs both the web session cookie and the mobile
 * bearer token — see docs/API.md "Auth" and docs/SECURITY.md for why a
 * hand-rolled jose-based JWT was chosen over a cookie-first auth library:
 * the app needs one token shape that works identically from a browser
 * cookie and from React Native's SecureStore.
 */
export async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.userId !== "string") return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
