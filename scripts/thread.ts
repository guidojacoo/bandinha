import "../src/lib/loadEnv";
import { prisma } from "../src/infra/db";

async function main() {
  const email = process.argv[2] ?? "dmitri@meridianpay.test";
  const msgs = await prisma.message.findMany({
    where: { contact: { email } },
    orderBy: { createdAt: "asc" },
  });
  for (const m of msgs) {
    const a = m.analysis as { intent?: string; objection?: string; confidence?: number } | null;
    const tag = m.direction === "outbound" ? `OUT [${m.status}]` : `IN  [${a?.intent}/${a?.objection} c=${a?.confidence?.toFixed(2)}]`;
    console.log(`\n--- ${tag} ${m.subject}`);
    console.log(m.body.split("\n").slice(0, 6).map((l) => "    " + l).join("\n"));
  }
  const deal = await prisma.deal.findFirst({ where: { lead: { contacts: { some: { email } } } } });
  console.log("\nSTAGE:", deal?.stage);
  await prisma.$disconnect();
}
main();
