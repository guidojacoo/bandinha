import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import { db } from "../infra/db";
import { ask, colour, heading, run } from "./lib";

/**
 * `npm run setup` — everything needed before the first run.
 *
 * Creates .env, creates the SQLite file, applies the schema, and creates the
 * operator account. Deliberately the only setup step there is: the product
 * claims to be free and setup-free, and every service a user has to sign up
 * for before seeing anything is a reason they never will.
 */

run(async () => {
  heading("Mercurio setup");

  const envPath = ".env";
  if (!existsSync(envPath)) {
    const example = existsSync(".env.example") ? readFileSync(".env.example", "utf8") : DEFAULT_ENV;
    writeFileSync(envPath, example);
    console.log(`${colour.green("✓")} Wrote ${envPath}`);
  } else {
    console.log(`${colour.dim("·")} ${envPath} already exists, left alone.`);
  }

  const url = process.env.DATABASE_URL ?? "file:./data/mercurio.db";
  const file = url.replace(/^file:/, "");
  mkdirSync(dirname(file) || ".", { recursive: true });

  console.log(`${colour.dim("·")} Applying the schema to ${file}…`);
  try {
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      stdio: process.env.DEBUG === "1" ? "inherit" : "pipe",
      env: { ...process.env, DATABASE_URL: url },
    });
    console.log(`${colour.green("✓")} Database ready.`);
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
  console.log(`  ${colour.bold("npm run demo")}     watch a full run against the bundled fixture web`);
  console.log(`  ${colour.bold("npm run sell")} <url>   start a campaign from a real website`);
  console.log(`  ${colour.bold("npm run doctor")}   check what is configured and what is missing`);
  console.log(`  ${colour.bold("npm run dev")}      the operator console on http://localhost:3000\n`);
  console.log(colour.dim("Nothing is sent to a real address until SMTP is configured AND a campaign has live sending armed."));
});

const DEFAULT_ENV = `DATABASE_URL="file:./data/mercurio.db"
AUTH_SECRET="change-me-to-something-random"
GROQ_API_KEY=""
`;
