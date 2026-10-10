import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { siteFor, world } from "./world";

/**
 * Serves the fixture web over HTTP.
 *
 * One server, routing by Host header, so the agent sees ten separate
 * companies on ten separate domains and the crawler's same-origin rules,
 * robots handling and politeness delays all behave as they would on the real
 * web. `npm run fixtures:hosts` points the `.test` names at localhost.
 *
 * It also serves a robots.txt per site — one of which disallows a path, so
 * the run proves the crawler honours it rather than merely containing the
 * code to.
 */

const PORT = Number(process.env.FIXTURE_PORT ?? 8080);

const ROBOTS: Record<string, string> = {
  // Nothing restricted: the common case.
  default: "User-agent: *\nDisallow:\n",
  // A prospect that asks crawlers to stay out of its careers section. The
  // agent should respect it and still qualify the company from other pages.
  "quaypoint.test": "User-agent: *\nDisallow: /careers\n",
};

function handle(request: IncomingMessage, response: ServerResponse): void {
  const host = request.headers.host ?? "";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const site = siteFor(host);

  if (!site) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`No fixture site for host "${host}". Known: ${world.map((s) => s.domain).join(", ")}\n`);
    return;
  }

  if (url.pathname === "/robots.txt") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(ROBOTS[site.domain] ?? ROBOTS.default);
    return;
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const html = site.pages[path];
  if (!html) {
    response.writeHead(404, { "content-type": "text/html" });
    response.end(`<!doctype html><title>404</title><p>Not found: ${path}</p>`);
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

const server = createServer(handle);

server.listen(PORT, "127.0.0.1", () => {
  const pages = world.reduce((sum, site) => sum + Object.keys(site.pages).length, 0);
  console.log(`Fixture web on http://127.0.0.1:${PORT} — ${world.length} sites, ${pages} pages.`);
  for (const site of world) {
    console.log(`  http://${site.domain}:${PORT}/  ${site.expect === "reject" ? "(should be rejected)" : ""}`);
  }
  console.log(`\nIf those names do not resolve, run: sudo npm run fixtures:hosts`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
