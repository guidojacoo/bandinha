import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { TEST_DB_PATH, TEST_DB_URL } from "./db-path";

/** Creates the throwaway database once, before any test file runs. */
export async function setup(): Promise<void> {
  rmSync(TEST_DB_PATH, { force: true });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
  });
}

export async function teardown(): Promise<void> {
  rmSync(TEST_DB_PATH, { force: true });
  rmSync(`${TEST_DB_PATH}-journal`, { force: true });
}
