import { defineConfig } from "vitest/config";

// Only pure modules are unit-tested: scoring, evidence, deliverability,
// provenance, cadence, compliance, classification, parsing and the LLM
// budget. Nothing here touches the network, the database or a model.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
