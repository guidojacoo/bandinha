import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * A server that speaks Groq's API.
 *
 * Groq is unreachable from the machine this was written on, which left the
 * entire model path — the client, the prompts, the JSON extraction, the
 * critique loop, the budget accounting, the 429 handling — asserted rather
 * than demonstrated. That is a bad place for the most load-bearing
 * integration in the product to sit.
 *
 * So this implements the protocol instead: the same endpoint, the same
 * request shape, the same `usage` block, the same error bodies, including the
 * ones that matter and are easy to get wrong. Running the agent against it
 * proves everything except the real model's taste.
 *
 * It is deliberately a *difficult* server. By default the first completion it
 * returns is mediocre on purpose — filler opening, two questions, a hedge —
 * so the quality scorer rejects it and the critique loop has to do its job.
 * A mock that always answers perfectly would prove nothing about the part of
 * the system designed to handle imperfection.
 */

export interface MockGroqOptions {
  port?: number;
  apiKey?: string;
  /** Fail this many requests with 429 before answering. */
  rateLimitFirst?: number;
  /** Fail this many requests with 500 before answering. */
  serverErrorFirst?: number;
  /** Wrap JSON responses in prose and markdown fences, as models do. */
  messy?: boolean;
  /** Return an empty completion this many times before answering. */
  emptyFirst?: number;
  /** Answer the first compose request with deliberately weak copy. */
  weakFirstDraft?: boolean;
}

export interface MockGroqHandle {
  url: string;
  port: number;
  /** Every request received, for assertions about what was actually sent. */
  requests: Array<{ model: string; system: string; user: string; maxTokens: number; temperature: number }>;
  close(): Promise<void>;
}

interface ChatRequest {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  max_tokens?: number;
  temperature?: number;
}

export async function startMockGroq(options: MockGroqOptions = {}): Promise<MockGroqHandle> {
  const apiKey = options.apiKey ?? "test-key";
  const requests: MockGroqHandle["requests"] = [];

  let rateLimited = 0;
  let serverErrored = 0;
  let emptied = 0;
  let composeCalls = 0;

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);

    if (!request.url?.includes("/chat/completions")) {
      // The models endpoint, which `doctor` uses to check a key.
      if (request.url?.includes("/models")) {
        return json(response, 200, { object: "list", data: [{ id: "llama-3.3-70b-versatile", object: "model" }] });
      }
      return json(response, 404, { error: { message: "Unknown path", type: "invalid_request_error" } });
    }

    let parsed: ChatRequest = {};
    try {
      parsed = JSON.parse(body) as ChatRequest;
    } catch {
      return json(response, 400, { error: { message: "Could not parse body as JSON", type: "invalid_request_error" } });
    }

    const system = parsed.messages?.find((m) => m.role === "system")?.content ?? "";
    const user = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
    // Recorded before the auth check, so a test can assert how many times a
    // rejected key was retried.
    requests.push({
      model: parsed.model ?? "",
      system,
      user,
      maxTokens: parsed.max_tokens ?? 0,
      temperature: parsed.temperature ?? 0,
    });

    const auth = request.headers.authorization ?? "";
    if (auth !== `Bearer ${apiKey}`) {
      // Groq's shape for a bad key. The client must degrade, not retry.
      return json(response, 401, {
        error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" },
      });
    }

    if (rateLimited < (options.rateLimitFirst ?? 0)) {
      rateLimited++;
      // Groq reports its own wait inside the message, which is the only place
      // it appears — there is no Retry-After header to read.
      return json(response, 429, {
        error: {
          message:
            "Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_test` on tokens per minute (TPM): Limit 6000, Used 5987, Requested 420. Please try again in 1.317s. Need more? https://console.groq.com/settings/billing",
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      });
    }

    if (serverErrored < (options.serverErrorFirst ?? 0)) {
      serverErrored++;
      return json(response, 503, { error: { message: "Service Unavailable", type: "internal_server_error" } });
    }

    if (emptied < (options.emptyFirst ?? 0)) {
      emptied++;
      return json(response, 200, completion("", parsed, system, user));
    }

    const isCompose = /one cold email/i.test(system);
    const isReply = /replying to a prospect/i.test(system);
    const isRepair = /previous attempt was rejected/i.test(user);

    let content: string;
    if (isCompose) {
      composeCalls++;
      const weak = options.weakFirstDraft !== false && composeCalls === 1 && !isRepair;
      content = weak ? WEAK_DRAFT(user) : goodDraft(user);
    } else if (isReply) {
      content = replyDraft(user);
    } else if (/summarise what it sells/i.test(system)) {
      content = offeringJson(user);
    } else if (/ideal customer profile/i.test(system)) {
      content = icpJson();
    } else {
      content = JSON.stringify({ ok: true });
    }

    if (options.messy) {
      content = `Sure — here is the JSON you asked for:\n\n\`\`\`json\n${content}\n\`\`\`\n\nLet me know if you want it adjusted.`;
    }

    return json(response, 200, completion(content, parsed, system, user));
  }

  const port = await listen(server, options.port ?? 0);
  return {
    url: `http://127.0.0.1:${port}/openai/v1`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// The completions themselves
// ---------------------------------------------------------------------------

/** Pulls a labelled field out of the brief, so the "model" appears to read it. */
function field(user: string, heading: string): string {
  const match = user.match(new RegExp(`## ${heading}\\n([\\s\\S]*?)(?:\\n## |$)`));
  return (match?.[1] ?? "").trim();
}

function quoteFrom(user: string): string {
  const block = field(user, "The quote you must use");
  const match = block.match(/^"([\s\S]*?)"/m);
  return (match?.[1] ?? "").trim();
}

function sourceFrom(user: string): string {
  const match = field(user, "The quote you must use").match(/Source:\s*(\S+)/);
  return match?.[1] ?? "";
}

function themFrom(user: string): string {
  const match = field(user, "Them").match(/^(.+?)\s*\(/m);
  return (match?.[1] ?? "them").trim();
}

/**
 * What a model actually produces on a first pass: an opening the prompt
 * banned, two questions, a hedge, and a buzzword.
 */
function WEAK_DRAFT(user: string): string {
  const them = themFrom(user);
  return JSON.stringify({
    subject: "Improving Your Alerting Strategy",
    body: [
      "Hi there,",
      "",
      `I hope this finds you well! I came across ${them} and wanted to reach out, as we help teams leverage best-in-class observability to unlock seamless visibility.`,
      "",
      "If you have a moment, I was wondering whether you might be open to a quick call? What does your calendar look like next week?",
      "",
      "Thoughts?",
      "",
      "Best",
    ].join("\n"),
    provenance: [],
  });
}

/** What it produces once the critique has told it exactly what was wrong. */
function goodDraft(user: string): string {
  const quote = quoteFrom(user);
  const source = sourceFrom(user);
  const them = themFrom(user);
  const paraphrase = quote
    .replace(/^(?:our|we)\b/i, (m) => (/^our$/i.test(m) ? "Your" : "You"))
    .replace(/\bour\b/gi, "your")
    .replace(/[.!?]+$/, "");

  return JSON.stringify({
    subject: "forty pages a week",
    body: [
      "Hi there,",
      "",
      `${paraphrase} — that was the line on your site I kept rereading.`,
      "",
      "The pager is rarely the problem on its own; it is that nobody can tell which of those pages was worth waking up for.",
      "",
      `Is that something ${them} is already working on, or has it just become background?`,
      "",
      "Dana",
    ].join("\n"),
    provenance: quote ? [{ claim: quote, source, kind: "prospect" }] : [],
  });
}

function replyDraft(user: string): string {
  const objection = field(user, "How that reads");
  const incumbent = /incumbent/i.test(objection);
  return JSON.stringify({
    body: [
      "Hi there,",
      "",
      incumbent
        ? "That is usually the case, and it is a fair question. The part that tends to differ is which signal the alert fires on rather than how the alerting is wired."
        : "Understood, and thanks for telling me rather than leaving it.",
      "",
      incumbent ? "Where does your current setup leave somebody doing it by hand?" : "What would make it worth a second look?",
      "",
      "Dana",
    ].join("\n"),
    provenance: [],
  });
}

function offeringJson(user: string): string {
  const domain = (user.match(/Website:\s*(\S+)/)?.[1] ?? "example.test").trim();
  const home = `http://${domain}/`;
  return JSON.stringify({
    companyName: "Northwind",
    oneLiner: "Northwind tracks error budgets so the pager only fires when the budget is burning.",
    categories: ["observability", "devops tooling"],
    positioningPhrases: ["error budget tracking", "service level objectives"],
    pricingModel: "from $90 per month for up to twenty-five services",
    toneOfVoice: "direct, technical, no hype",
    products: [{
      name: "Northwind",
      summary: "Service level objective tracking with burn-rate alerting.",
      capabilities: ["error budget tracking", "burn rate alerts", "kubernetes integration"],
    }],
    // Deliberately attributed to a page that may not exist, so the
    // source-repair path in mergeOffering is exercised.
    valueProps: [{ text: "We help platform teams cut alert volume without turning off the alerts that matter.", source: `${home}made-up-page` }],
    proofPoints: [{ text: "Northwind is SOC 2 Type II certified and has been audited annually since 2024.", source: home }],
  });
}

function icpJson(): string {
  return JSON.stringify({
    summary: "Engineering organisations of 50-500 running microservices with on-call pain.",
    industries: ["observability", "saas", "logistics software", "payments", "healthcare software", "developer tooling", "energy software"],
    // Backwards on purpose: normaliseIcp has to swap them.
    sizeMin: 600,
    sizeMax: 40,
    buyerTitles: ["VP Engineering", "Head of Platform", "SRE Lead", "Engineering Manager", "Director of Platform", "CTO"],
    painSignals: [
      "on-call", "paged", "alerts", "alert noise", "uptime", "error budget",
      "service level objectives", "incident", "wake somebody up", "woken",
      "by hand", "spreadsheet",
    ],
    positiveSignals: ["kubernetes", "prometheus", "opentelemetry", "microservices", "kafka"],
    negativeSignals: ["error budget tracking"],
    geographies: [],
  });
}

function completion(content: string, request: ChatRequest, system: string, user: string) {
  // Token counts near enough to be useful for budget assertions.
  const prompt = Math.ceil((system.length + user.length) / 3.6);
  const output = Math.ceil(content.length / 3.6);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "llama-3.3-70b-versatile",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      logprobs: null,
      finish_reason: content ? "stop" : "length",
    }],
    usage: {
      queue_time: 0.002,
      prompt_tokens: prompt,
      prompt_time: 0.01,
      completion_tokens: output,
      completion_time: 0.08,
      total_tokens: prompt + output,
      total_time: 0.09,
    },
    system_fingerprint: "fp_test",
    x_groq: { id: randomUUID() },
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}
