import { defineConfig } from "vitest/config";

// Only the pure core is unit-tested here: scoring, sequencing, compliance,
// classification and parsing. Nothing in this suite touches the network,
// the database, or an LLM.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
