import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import { db, dbFilePath, dbUrl } from "../infra/db";
import { ask, colour, heading, run } from "./lib";

/**
 * `npm run setup` — everything needed before the first run.
 *
 * Creates .env, creates the SQLite file, applies the schema, and creates the
 * operator account. Deliberately the only setup step there is: the product
 * claims to be free and setup-free, and every service a user has to sign up
 * for before seeing anything is a reason they never will.
 */

const PLACEHOLDER_SECRET = "change-me-to-something-random";

const DEFAULT_ENV = `DATABASE_URL="file:./data/mercurio.db"
AUTH_SECRET="${PLACEHOLDER_SECRET}"
GROQ_API_KEY=""
`;

/**
 * A server URL with the credentials taken out.
 *
 * Setup prints what it is about to write to, and a connection string printed
 * in full is a password in a terminal, a screenshot and a scrollback buffer.
 */
function describeServer(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return "the configured database";
  }
}

run(async () => {
  heading("Mercurio setup");

  const envPath = ".env";
  if (!existsSync(envPath)) {
    const example = existsSync(".env.example") ? readFileSync(".env.example", "utf8") : DEFAULT_ENV;
    // The signing key is generated here rather than left as a placeholder.
    // The console refuses to issue a session on the placeholder value, and
    // asking someone to generate a key by hand before they can log in is
    // exactly the kind of setup step that makes people give up.
    writeFileSync(envPath, example.replace(PLACEHOLDER_SECRET, randomBytes(32).toString("hex")));
    console.log(`${colour.green("✓")} Wrote ${envPath}, with a fresh AUTH_SECRET.`);
  } else if (readFileSync(envPath, "utf8").includes(PLACEHOLDER_SECRET)) {
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(PLACEHOLDER_SECRET, randomBytes(32).toString("hex")),
    );
    console.log(`${colour.green("✓")} Replaced the placeholder AUTH_SECRET in ${envPath}.`);
  } else {
    console.log(`${colour.dim("·")} ${envPath} already exists, left alone.`);
  }

  // The same absolute URL the application will use. Resolving it here rather
  // than passing a relative path is the whole fix for a fresh install:
  // `prisma db push` resolves a relative SQLite path against the schema's
  // directory and the client resolves it against the working directory, so a
  // relative path created the database in one place and looked for it in
  // another — and this step reported success either way.
  const url = dbUrl();
  const file = dbFilePath();

  const target = file ?? describeServer(url);
  if (file) mkdirSync(dirname(file) || ".", { recursive: true });

  console.log(`${colour.dim("·")} Applying the schema to ${target}…`);
  try {
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      stdio: process.env.DEBUG === "1" ? "inherit" : "pipe",
      env: { ...process.env, DATABASE_URL: url },
    });
    // Trust, then verify. "Database ready" followed by an application that
    // cannot find a database is the worst possible first five minutes.
    if (file && !existsSync(file)) {
      throw new Error(`The schema was applied but there is no database at ${file}. Set DATABASE_URL to an absolute path and try again.`);
    }
    console.log(`${colour.green("✓")} Database ready${file ? ` at ${file}` : ""}.`);
  } catch (error) {
    console.error(`${colour.red("✗")} Could not apply the schema.`);
    throw error;
  }

  const existing = await db.user.count();
  if (existing > 0) {
    console.log(`${colour.dim("·")} ${existing} account(s) already exist, so no new one was created.`);
  } else {
    heading("Operator account");
    console.log("This is the login for the console at http://localhost:3000.\n");
    const email = await ask("Email:", "you@example.com");
    let password = await ask("Password (8+ characters):");
    while (password.length < 8) {
      console.log(colour.yellow("  Too short — eight characters minimum."));
      password = await ask("Password:");
    }
    const name = await ask("Your name:", "Operator");

    await db.user.create({
      data: { email: email.toLowerCase(), name, passwordHash: await bcrypt.hash(password, 10) },
    });
    console.log(`${colour.green("✓")} Account created for ${email}.`);
  }

  heading("Next");
  console.log(`  ${colour.bold("npm run build && npm start")}   the console on :3000, and a worker`);
  console.log(colour.dim("    Both. A console with no worker looks perfectly healthy and never does anything.\n"));
  console.log(`  ${colour.bold("npm run acceptance")}           with it running: twenty-one checks that it works`);
  console.log(`  ${colour.bold("npm run demo")}                 watch a full run against the bundled fixture web`);
  console.log(`  ${colour.bold("npm run doctor")}               what is configured here, and what is missing`);
  console.log(`  ${colour.bold("npm run sell")} <url>           start a campaign from a terminal instead\n`);
  console.log(colour.dim("Nothing is sent to a real address until SMTP is configured AND a campaign has live sending armed."));
});
