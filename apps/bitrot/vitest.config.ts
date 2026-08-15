import { defineConfig } from "vitest/config";

// Only the pure modules are unit-tested: scoring, manifest parsing, and the
// registry *normalisers* (fed recorded payloads). Nothing here touches the
// network or the database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
