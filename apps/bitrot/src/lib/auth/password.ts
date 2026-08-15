import bcrypt from "bcryptjs";

const ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Constant-ish work factor for logins against an unknown email.
 *
 * Comparing against a dummy hash keeps a failed lookup roughly as slow as a
 * failed password, so response timing does not reveal which emails exist.
 */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.7VMlPQtL0eIzq3XyfnRcAPUxvhoAyRi";

export async function burnPasswordTime(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}
