import "../src/lib/loadEnv";
import { prisma } from "../src/infra/db";

async function main() {
  const leads = await prisma.lead.findMany({ orderBy: [{ fitScore: "desc" }], include: { contacts: true } });
  console.log("DOMAIN".padEnd(26), "SCORE".padStart(5), "BAND".padEnd(13), "STATUS".padEnd(10), "CTS", "REJECTED");
  for (const l of leads) {
    console.log(
      l.domain.padEnd(26),
      String(l.fitScore ?? "-").padStart(5),
      (l.fitBand ?? "-").padEnd(13),
      l.status.padEnd(10),
      String(l.contacts.length).padStart(3),
      (l.rejectedReason ?? "").slice(0, 55),
    );
  }
  const enr = await prisma.enrollment.findMany({ include: { contact: true } });
  console.log("\nENROLLMENTS");
  for (const e of enr) console.log(` ${e.contact.email.padEnd(34)} ${e.state} nextDue=${e.nextDueAt?.toISOString() ?? "null"}`);
  console.log("\nNOW:", new Date().toISOString(), "weekday", new Date().getUTCDay());
  await prisma.$disconnect();
}
main();
