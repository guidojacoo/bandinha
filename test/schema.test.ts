import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, currentProvider, withProvider } from "../scripts/datasource";

/**
 * The claim that this runs on Postgres without a rewrite.
 *
 * It is easy to say and easy to quietly stop being true: one `Json` column,
 * one native enum, one `@db.` attribute, and moving engines becomes a
 * migration project instead of a command. So the claim is a test.
 *
 * The constraints were SQLite's to begin with — no enums, no JSON type — and
 * keeping them is what makes the schema portable for free. These assertions
 * are what stop the next person relaxing one without noticing what it costs.
 */

const schema = readFileSync(resolve(__dirname, "../prisma/schema.prisma"), "utf8");

/** The schema minus its comments, so prose cannot trip a pattern. */
const code = schema
  .split("\n")
  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///"))
  .join("\n");

/**
 * Whether this run is itself the proof.
 *
 * `TEST_DATABASE_URL` means the suite has been pointed at a real server, and
 * the schema has necessarily been flipped to get there — the generated client
 * is built for one provider at a time. So the one assertion about the shipped
 * default cannot hold during the run that proves the alternative works, and
 * the swap is checked symmetrically instead.
 */
const flipped = Boolean(process.env.TEST_DATABASE_URL);

describe("switching the datasource", () => {
  it.skipIf(flipped)("ships on SQLite, because a database server is not free to run", () => {
    expect(currentProvider(schema)).toBe("sqlite");
  });

  it("swaps the provider and nothing else", () => {
    const from = currentProvider(schema);
    const to = from === "sqlite" ? "postgresql" : "sqlite";
    const moved = withProvider(schema, to);
    expect(currentProvider(moved)).toBe(to);
    // Byte-for-byte identical apart from the one word.
    expect(moved.replace(`provider = "${to}"`, `provider = "${from}"`)).toBe(schema);
  });

  it("round-trips", () => {
    const from = currentProvider(schema);
    const to = from === "sqlite" ? "postgresql" : "sqlite";
    expect(withProvider(withProvider(schema, to), from)).toBe(schema);
  });

  it("refuses a provider nobody has reasoned about", () => {
    // MySQL would need thinking about: no `String` of unbounded length in an
    // index, different NULL semantics in unique indexes. Saying no is honest.
    expect(() => withProvider(schema, "mysql")).toThrow(/Unknown provider/);
    expect(PROVIDERS).toEqual(["sqlite", "postgresql"]);
  });
});

describe("nothing in the schema is engine-specific", () => {
  it("declares no native enums", () => {
    // SQLite has none, so status columns are strings with TypeScript unions in
    // core/types.ts as the single source of truth. That was a constraint; it
    // is now portability.
    expect(code).not.toMatch(/^\s*enum\s+\w+\s*\{/m);
  });

  it("declares no Json columns", () => {
    expect(code).not.toMatch(/^\s+\w+\s+Json\b/m);
  });

  it("uses no native type attributes", () => {
    // `@db.VarChar(255)`, `@db.Text` and friends are per-provider and are the
    // usual reason a schema stops being portable.
    expect(code).not.toMatch(/@db\./);
  });

  it("uses no Bytes or Decimal", () => {
    // Both exist on both engines and behave differently enough to matter;
    // nothing here needs either.
    expect(code).not.toMatch(/^\s+\w+\s+(Bytes|Decimal)\b/m);
  });

  it("names every table explicitly", () => {
    // Otherwise the table names are whatever Prisma pluralises the model to,
    // which has differed between versions.
    const models = [...code.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
    expect(models.length).toBeGreaterThan(10);
    for (const [, name, body] of models) {
      expect(body, `model ${name} has no @@map`).toMatch(/@@map\("/);
    }
  });
});

describe("the guarantees the queue depends on are in the schema", () => {
  it("keeps the dedupe key nullable and unique", () => {
    // The whole double-send defence. Nullable so a terminal job can release
    // it, unique so at most one live job per key can exist — and both engines
    // treat NULLs in a unique index as distinct, which is why this works on
    // either without a partial index.
    expect(code).toMatch(/dedupeKey\s+String\?\s+@unique/);
  });

  it("indexes the claim and the reaper queries", () => {
    expect(code).toMatch(/@@index\(\[status, runAt, priority\]\)/);
    expect(code).toMatch(/@@index\(\[status, leaseUntil\]\)/);
  });

  it("still cannot bill the same unit twice", () => {
    expect(code).toMatch(/@@unique\(\[clientId, leadId, kind\]\)/);
  });

  it("still allows one enrollment per contact", () => {
    expect(code).toMatch(/@@unique\(\[contactId\]\)/);
  });

  it("still suppresses an address once per operator", () => {
    expect(code).toMatch(/@@unique\(\[userId, email\]\)/);
  });
});
