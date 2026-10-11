import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the test database lives.
 *
 * A throwaway file, not the development one. Most of this suite is pure and
 * needs no database at all; the handful that do — the payment webhook, the
 * queue, the worker loop, the health endpoint — must not be able to write to
 * whatever the operator is actually using.
 *
 * `TEST_DATABASE_URL` points the same suite at a real database server, which
 * is how the "this runs on Postgres" claim gets proved rather than asserted:
 *
 *   npm run db:provider -- postgres && npx prisma generate
 *   TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5432/mercurio" npm test
 *
 * The generated client is built for one provider at a time, so the schema has
 * to be switched first; `prisma db push` says so plainly if it is not.
 */
export const TEST_DB_PATH = join(tmpdir(), "mercurio-test.db");
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? `file:${TEST_DB_PATH}`;

/** Whether the suite is running against a file we can simply delete. */
export const TEST_DB_IS_FILE = TEST_DB_URL.startsWith("file:");
