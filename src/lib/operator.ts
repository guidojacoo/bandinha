import bcrypt from "bcryptjs";
import { prisma } from "../infra/db";

/**
 * Resolves the operator account used by the CLI.
 *
 * The CLI has no session, so it uses the account named by OPERATOR_EMAIL,
 * creating it on first run. The dashboard shares the same user rows.
 */
export async function ensureOperator(
  email = process.env.OPERATOR_EMAIL ?? "operator@rainmaker.local",
  password = process.env.OPERATOR_PASSWORD ?? "rainmaker-local-operator",
): Promise<{ id: string; email: string; created: boolean }> {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { id: existing.id, email: existing.email, created: false };

  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 12), name: "Operator" },
  });
  return { id: user.id, email: user.email, created: true };
}
