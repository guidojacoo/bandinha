#!/usr/bin/env node
//
// `npm start` — the whole product, in one command.
//
// Two processes have to be running for this to be a working system: the
// console, and at least one worker. That is not an implementation detail
// somebody should have to discover — a console with no worker is the one
// failure mode where every page looks healthy and nothing ever happens. So
// the default command runs both, and this is the supervisor that does it.
//
// No dependency. A process manager is four npm packages and a config file for
// something Node can already do, and the whole product has to stay free of
// moving parts somebody has to install.
//
//   npm start                     console on :3000 and one worker
//   npm start -- --dev            the same, with hot reload
//   npm start -- --workers 3      three workers, for a lot of campaigns
//   npm start -- --no-worker      console only (workers are elsewhere)
//   npm start -- --worker-only    workers only (the console is elsewhere)
//
// The last two are how this scales past one machine: run the console where
// people can reach it, and workers wherever there is spare capacity. They
// coordinate through the queue, which is in the database, so they do not need
// to know about each other at all.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const has = (flag) => argv.includes(`--${flag}`);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(`--${flag}`);
  if (index === -1 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
};

const dev = has("dev");
const workers = Math.max(0, Number(valueOf("workers", process.env.WORKERS ?? 1)) || 0);
const wantConsole = !has("worker-only");
const wantWorkers = !has("no-worker") && workers > 0;
const concurrency = valueOf("concurrency", process.env.WORKER_CONCURRENCY ?? "2");
const port = valueOf("port", process.env.PORT ?? "3000");

const colour = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Refuse to start in a state that looks like it started
// ---------------------------------------------------------------------------
//
// Both of these produce a process that runs, answers, and does nothing useful.
// Saying so here costs one line and saves an hour of looking at an empty
// console wondering which part is broken.

function envFileValue(key) {
  for (const name of [".env", ".env.local"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const line = readFileSync(path, "utf8")
        .split("\n").find((l) => l.trim().startsWith(`${key}=`));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    } catch {
      // Unreadable .env is not this script's problem to report.
    }
  }
  return undefined;
}

const databaseUrl = process.env.DATABASE_URL ?? envFileValue("DATABASE_URL");
if (databaseUrl?.startsWith("file:")) {
  const file = resolve(root, databaseUrl.slice("file:".length));
  if (!existsSync(file)) {
    console.error(colour.red("\n✗ The database does not exist yet.\n"));
    console.error(`  Run ${colour.bold("npm run setup")} first. It creates the file, the schema and your login.\n`);
    process.exit(1);
  }
}

if (!dev && wantConsole && !existsSync(join(root, ".next"))) {
  console.error(colour.red("\n✗ The console has not been built.\n"));
  console.error(`  Run ${colour.bold("npm run build")} first, or ${colour.bold("npm start -- --dev")} to run it unbuilt.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The children
// ---------------------------------------------------------------------------

/**
 * How long a child has to stay up before its restart count resets.
 *
 * Without this, a process that crashes every hour for a week is eventually
 * treated as a crash loop and the supervisor gives up — which is exactly
 * backwards. Only failures close together mean something is actually broken.
 */
const HEALTHY_AFTER_MS = 60_000;
const MAX_RESTARTS = Number(process.env.SUPERVISOR_MAX_RESTARTS ?? 5);

const children = new Map();
let stopping = false;

function start(name, command, args, tag) {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, PORT: port, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state = children.get(name) ?? { restarts: 0 };
  state.child = child;
  state.startedAt = startedAt;
  children.set(name, state);

  const prefix = tag(name);
  const relay = (stream, toErr) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const out = `${prefix} ${line}`;
        if (toErr) process.stderr.write(`${out}\n`);
        else process.stdout.write(`${out}\n`);
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) process.stdout.write(`${prefix} ${buffer}\n`);
    });
  };
  relay(child.stdout, false);
  relay(child.stderr, true);

  child.on("exit", (code, signal) => {
    if (stopping) return;

    const ranFor = Date.now() - startedAt;
    if (ranFor >= HEALTHY_AFTER_MS) state.restarts = 0;
    state.restarts += 1;

    // A worker that exits 0 has finished its queue and stopped on purpose
    // (`--drain`, `--once`). Anything else is a fall over.
    const clean = code === 0 && signal === null;
    if (clean && name.startsWith("worker")) {
      console.log(`${prefix} ${colour.dim("finished and stopped.")}`);
      children.delete(name);
      if (children.size === 0) process.exit(0);
      return;
    }

    if (state.restarts > MAX_RESTARTS) {
      console.error(`${prefix} ${colour.red(`fell over ${state.restarts} times in under a minute each. Giving up.`)}`);
      console.error(`${prefix} ${colour.dim("A supervisor that restarts forever on a broken build looks exactly like one that is working.")}`);
      shutdown("a child kept failing", 1);
      return;
    }

    const backoff = Math.min(30_000, 1_000 * 2 ** (state.restarts - 1));
    console.error(`${prefix} ${colour.yellow(`exited (${signal ?? code}). Restarting in ${Math.round(backoff / 1000)}s.`)}`);
    setTimeout(() => {
      if (!stopping) start(name, command, args, tag);
    }, backoff);
  });

  child.on("error", (error) => {
    console.error(`${prefix} ${colour.red(`could not start: ${error.message}`)}`);
  });

  return child;
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const webTag = (name) => colour.cyan(`[${name}]`);
const workerTag = (name) => colour.green(`[${name}]`);

console.log(`\n${colour.bold("Mercurio")}`);
if (wantConsole) console.log(`  console   http://localhost:${port}${dev ? colour.dim("  (hot reload)") : ""}`);
if (wantWorkers) {
  console.log(`  worker${workers === 1 ? "    " : "s   "} ${workers} × ${concurrency} job(s) at a time`);
} else {
  console.log(colour.yellow("  no worker — nothing will happen until one runs somewhere"));
}
console.log(colour.dim(`  Ctrl-C stops everything. The worker hands its claims back, so nothing is lost.\n`));

if (wantConsole) {
  start("console", npx, dev ? ["next", "dev", "--port", String(port)] : ["next", "start", "--port", String(port)], webTag);
}

for (let i = 0; i < (wantWorkers ? workers : 0); i += 1) {
  const name = workers === 1 ? "worker" : `worker ${i + 1}`;
  start(name, npx, ["tsx", "src/cli/worker.ts", "--concurrency", String(concurrency)], workerTag);
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/**
 * Ask everything to stop, then insist.
 *
 * The worker's own shutdown hands its claims back without spending an
 * attempt, which takes a moment and is worth waiting for: a hard kill leaves
 * the claims to expire on their lease, which parks those campaigns for five
 * minutes. So SIGTERM first, SIGKILL only for whatever is still there after
 * the grace period.
 */
function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${colour.dim(`Stopping (${reason})…`)}`);

  for (const [name, state] of children) {
    if (state.child && state.child.exitCode === null) {
      state.child.kill("SIGTERM");
      void name;
    }
  }

  const grace = Number(process.env.SUPERVISOR_GRACE_MS ?? 15_000);
  const timer = setTimeout(() => {
    for (const [, state] of children) {
      if (state.child && state.child.exitCode === null) state.child.kill("SIGKILL");
    }
    process.exit(code);
  }, grace);

  const waiter = setInterval(() => {
    const alive = [...children.values()].filter((s) => s.child && s.child.exitCode === null);
    if (alive.length === 0) {
      clearTimeout(timer);
      clearInterval(waiter);
      process.exit(code);
    }
  }, 200);
}

process.on("SIGINT", () => shutdown("Ctrl-C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
