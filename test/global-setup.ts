import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { TEST_DB_IS_FILE, TEST_DB_PATH, TEST_DB_URL } from "./db-path";

/**
 * Creates the throwaway database once, before any test file runs.
 *
 * On a file that means deleting it and pushing the schema. On a server it
 * means pushing the schema with data loss accepted — which is why the
 * documentation for `TEST_DATABASE_URL` says a throwaway database and means
 * it: this drops and recreates whatever it is pointed at.
 */
export async function setup(): Promise<void> {
  if (TEST_DB_IS_FILE) rmSync(TEST_DB_PATH, { force: true });

  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--force-reset"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
  });
}

export async function teardown(): Promise<void> {
  if (!TEST_DB_IS_FILE) return;
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(`${TEST_DB_PATH}-journal`, { force: true });
}
