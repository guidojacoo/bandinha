import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the test database lives.
 *
 * A throwaway file, not the development one. Most of this suite is pure and
 * needs no database at all; the handful of tests that do — the payment
 * webhook, which is the only route that can record money — must not be able
 * to write to whatever the operator is actually using.
 */
export const TEST_DB_PATH = join(tmpdir(), "mercurio-test.db");
export const TEST_DB_URL = `file:${TEST_DB_PATH}`;
