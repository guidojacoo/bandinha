import { TEST_DB_URL } from "./db-path";

// Set before any module reads it, so `infra/db` connects to the throwaway
// file rather than the operator's own database.
process.env.DATABASE_URL = TEST_DB_URL;
