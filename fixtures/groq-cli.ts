import { startMockGroq } from "./groq-server";

/**
 * `npm run mock:groq` — the protocol server, standalone.
 *
 * For running the real agent end to end through the model path without a key
 * and without network access. Point the agent at it:
 *
 *   GROQ_BASE_URL=http://127.0.0.1:8099/openai/v1 GROQ_API_KEY=test-key npm run demo
 *
 * It is not a model. It returns a deliberately mediocre first draft so the
 * critique loop has to run, and then copy shaped the way the prompt asks for.
 * What it proves is the plumbing; what it cannot prove is taste.
 */

const port = Number(process.env.MOCK_GROQ_PORT ?? 8099);

startMockGroq({ port, apiKey: process.env.GROQ_API_KEY ?? "test-key" })
  .then((handle) => {
    console.log(`Mock Groq on ${handle.url}`);
    console.log(`\nPoint the agent at it:`);
    console.log(`  GROQ_BASE_URL=${handle.url} GROQ_API_KEY=test-key npm run demo\n`);
    console.log(`First compose request returns weak copy on purpose, so the critique loop runs.`);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void handle.close().then(() => process.exit(0));
      });
    }
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
