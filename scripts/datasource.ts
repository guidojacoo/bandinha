#!/usr/bin/env node
//
// `npm run db:provider -- postgres` — move the whole thing onto Postgres.
//
// SQLite is the right default and it has one ceiling: a single writer. One
// console and two workers on a file is fine; a dozen workers on a file spend
// their time retrying SQLITE_BUSY. That is the point to move, and it should be
// one command rather than a migration project.
//
// Everything else already works on both, by construction rather than by luck:
//
//   - No native enums anywhere. Status columns are strings with TypeScript
//     unions as the source of truth, which was a SQLite constraint and is now
//     portability for free.
//   - No Json columns. Structured fields are TEXT read through typed helpers.
//   - The queue's claim is a conditional UPDATE rather than SELECT ... FOR
//     UPDATE SKIP LOCKED, so it needs nothing a file cannot do and gets
//     stronger, not weaker, on a real database.
//   - The at-most-one-live-job guarantee is a unique index with a nullable
//     key. Both engines treat NULLs in a unique index as distinct.
//
// So the only difference between the two schemas is the provider line, and
// this script is here to change it without anybody hand-editing a file that
// Prisma reads at build time. `--check` prints what is set without touching
// anything, which is what the tests use.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const schemaPath = resolve(__dirname, "../prisma/schema.prisma");

/** The providers this has actually been reasoned about for. */
export const PROVIDERS = ["sqlite", "postgresql"] as const;

export type Provider = (typeof PROVIDERS)[number];

const ALIASES: Record<string, Provider> = {
  sqlite: "sqlite",
  file: "sqlite",
  postgres: "postgresql",
  postgresql: "postgresql",
  pg: "postgresql",
};

const DATASOURCE = /(datasource\s+db\s*\{[^}]*?provider\s*=\s*")([^"]+)(")/;

export function currentProvider(schema: string): string {
  const match = schema.match(DATASOURCE);
  if (!match?.[2]) throw new Error("Could not find the datasource block in prisma/schema.prisma.");
  return match[2];
}

/**
 * Swap the provider, and change nothing else.
 *
 * Deliberately a surgical replacement rather than a template: the schema is
 * the single source of truth for the data model and a generator that rewrote
 * it would be a second one, guaranteed to drift. The assertion below is the
 * teeth — if a swap changed a single other character, it refuses.
 */
export function withProvider(schema: string, provider: string): string {
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown provider ${provider}. One of: ${PROVIDERS.join(", ")}.`);
  }
  const next = schema.replace(
    DATASOURCE,
    (_match, before: string, _was: string, after: string) => `${before}${provider}${after}`,
  );
  const before = currentProvider(schema);
  if (next.length - schema.length !== provider.length - before.length) {
    throw new Error("The provider swap changed more than the provider. Refusing to write it.");
  }
  return next;
}

function main() {
  const argv = process.argv.slice(2);
  const schema = readFileSync(schemaPath, "utf8");
  const current = currentProvider(schema);

  if (argv.includes("--check") || argv.length === 0) {
    console.log(current);
    return;
  }

  const requested = ALIASES[String(argv[0]).toLowerCase().replace(/^--/, "")];
  if (!requested) {
    console.error(`Unknown provider "${argv[0]}". Use: sqlite, postgres.`);
    process.exit(1);
  }

  if (requested === current) {
    console.log(`Already on ${current}; nothing to do.`);
    return;
  }

  writeFileSync(schemaPath, withProvider(schema, requested));
  console.log(`prisma/schema.prisma: ${current} → ${requested}\n`);

  if (requested === "postgresql") {
    console.log("Next, in order:");
    console.log("  1. Put a Postgres URL in .env:");
    console.log('       DATABASE_URL="postgresql://user:pass@host:5432/mercurio?sslmode=require"');
    console.log("     Neon and Supabase both have a free tier that fits this, and docker compose");
    console.log("     up brings one up locally — see deploy/README.md.");
    console.log("  2. npm run db:push        apply the schema");
    console.log("  3. npm run setup          create your account (it skips the database if it is ready)");
    console.log("  4. npm start -- --workers 4");
    console.log("\nThe data in your SQLite file does not come with you. Nothing here migrates rows:");
    console.log("a prospect pipeline is cheap to rebuild and a half-finished row migration is not.");
  } else {
    console.log("Back on a file. DATABASE_URL should be file:./data/mercurio.db, then npm run db:push.");
  }
}

// Only when run, not when imported by a test.
if (process.argv[1] && /datasource\.[cm]?ts$/.test(process.argv[1])) {
  main();
}
