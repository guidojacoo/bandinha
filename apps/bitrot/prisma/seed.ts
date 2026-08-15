/**
 * Seeds a demo account and runs one real scan against the live registries.
 *
 * Deliberately not fixture data: the whole point of the product is that the
 * numbers come from the registry, so the seed resolves real packages and the
 * scores it stores are whatever the registry says today.
 *
 *   npm run seed --workspace apps/bitrot
 */
import { PrismaClient } from "../src/generated/prisma";
import { hashPassword } from "../src/lib/auth/password";
import { parseManifest } from "../src/lib/parse";
import { runScan } from "../src/lib/scanner";

const prisma = new PrismaClient();

const DEMO_EMAIL = process.env.SEED_EMAIL ?? "demo@bitrot.dev";
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "bitrot-demo-account";

const LEGACY_PACKAGE_JSON = JSON.stringify(
  {
    name: "legacy-service",
    version: "2.4.0",
    dependencies: {
      express: "^4.17.1",
      request: "^2.88.2",
      moment: "^2.29.1",
      lodash: "^4.17.20",
      colors: "^1.4.0",
      "left-pad": "^1.3.0",
      "node-uuid": "^1.4.8",
      react: "^17.0.2",
    },
    devDependencies: { istanbul: "^0.4.5", typescript: "^5.6.3" },
  },
  null,
  2,
);

const LEGACY_REQUIREMENTS = `requests==2.28.1
flask==2.2.2
nose==1.3.7
distribute==0.7.3
pytz==2022.1
sqlalchemy>=1.4
`;

async function main() {
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: "Demo",
      passwordHash: await hashPassword(DEMO_PASSWORD),
    },
  });
  console.log(`✓ demo user: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

  for (const [label, text] of [
    ["legacy-service/package.json", LEGACY_PACKAGE_JSON],
    ["legacy-service/requirements.txt", LEGACY_REQUIREMENTS],
  ] as const) {
    const manifest = parseManifest(text, label);
    process.stdout.write(`  resolving ${manifest.dependencies.length} packages for ${label}… `);
    const scanId = await runScan({ userId: user.id, label, manifest });
    const scan = await prisma.scan.findUniqueOrThrow({ where: { id: scanId } });
    console.log(`rot ${scan.portfolioScore} (${scan.grade})`);
  }

  console.log("\nSeed complete. Sign in and open the dashboard.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
