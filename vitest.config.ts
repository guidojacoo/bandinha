import { defineConfig } from "vitest/config";

/**
 * Most of this suite is pure: scoring, evidence, deliverability, provenance,
 * cadence, compliance, classification, parsing, copy quality and billing
 * arithmetic, none of which touch the network, the database or the clock.
 *
 * Two exceptions, both deliberate. `groq-wire` runs the real model client
 * against a local server that implements Groq's protocol, because Groq is
 * unreachable from here and the alternative was shipping that path untested.
 * `payments` exercises the only route that can record money, against a
 * throwaway database created by `global-setup` — never the operator's own.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-env.ts"],
    // The database-backed tests share one file, so they must not race.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
