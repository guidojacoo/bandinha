import "../src/lib/loadEnv";
import { prisma } from "../src/infra/db";
import type { FitResult, Icp } from "../src/core/types";

async function main() {
  const campaign = await prisma.campaign.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  const icp = campaign.icp as unknown as Icp;
  console.log("PAIN SIGNALS :", icp.painSignals.join(", "));
  console.log("POSITIVE     :", icp.positiveSignals.join(", "));
  console.log("INDUSTRIES   :", icp.industries.join(", "));
  console.log("NEGATIVE     :", icp.negativeSignals.join(" | "));
  console.log();

  const leads = await prisma.lead.findMany({ where: { campaignId: campaign.id }, orderBy: { fitScore: "desc" } });
  for (const l of leads) {
    const fit = l.fit as unknown as FitResult | null;
    if (!fit) continue;
    console.log(`${l.companyName} — ${fit.score} (${fit.band})`);
    for (const s of fit.signals) {
      if (s.weight === 0 && s.value === 0) continue;
      const v = s.value === null ? "n/a " : `${Math.round(s.value * 100)}%`.padStart(4);
      console.log(`   ${s.label.padEnd(16)} w${String(s.weight).padStart(2)} ${v}  ${s.detail.slice(0, 72)}`);
    }
    console.log();
  }
  await prisma.$disconnect();
}
main();
