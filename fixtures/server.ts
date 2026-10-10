import { createServer } from "node:http";
import {
  DIRECTORY_HOST, PROSPECT_HOSTS, SITES, siteByHost,
  type FixturePage, type FixtureSite,
} from "./world";

/**
 * Serves the fixture world over real HTTP with Host-based virtual hosting.
 *
 * Every hostname in `world.ts` resolves to 127.0.0.1 via /etc/hosts, so the
 * agent crawls `http://hoverboard.test:4000` exactly as it would crawl a real
 * site: real DNS, real HTTP, real HTML, real robots.txt. Nothing about the
 * crawler, extractor or scorer is stubbed out for the demo.
 */

const PORT = Number(process.env.FIXTURE_PORT ?? 4000);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function jsonLd(site: FixtureSite): string {
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: site.pages[0]?.title.split(/[—|-]/)[0]?.trim() ?? site.host,
    url: `http://${site.host}:${PORT}/`,
  };
  if (site.employees) node.numberOfEmployees = { "@type": "QuantitativeValue", value: site.employees };
  if (site.address) node.address = site.address;
  return `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
}

function navFor(site: FixtureSite): string {
  const links = site.pages
    .map((p) => `<a href="${p.path}">${escapeHtml(p.title.split(/[—|-]/)[0]!.trim() || p.path)}</a>`)
    .join(" · ");
  return `<nav>${links}</nav>`;
}

function directoryListing(): string {
  const rows = PROSPECT_HOSTS.map((host) => {
    const site = siteByHost(host)!;
    return `<li><a href="http://${host}:${PORT}/">${escapeHtml(site.pages[0]!.title)}</a> — ${escapeHtml(site.blurb)}</li>`;
  }).join("\n");
  return `<h2>Listed companies</h2>\n<ul>\n${rows}\n</ul>`;
}

function renderPage(site: FixtureSite, page: FixturePage): string {
  const emails = (page.emails ?? [])
    .map(
      (e) =>
        `<li>${e.name ? `<strong>${escapeHtml(e.name)}</strong>` : ""}${
          e.title ? `, ${escapeHtml(e.title)} ` : " "
        }<a href="mailto:${e.address}">${e.address}</a></li>`,
    )
    .join("\n");

  // The directory's listing is injected rather than hand-written, so adding a
  // prospect to world.ts automatically makes it discoverable.
  const extra = site.host === DIRECTORY_HOST ? directoryListing() : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
${page.description ? `<meta name="description" content="${escapeHtml(page.description)}">` : ""}
${jsonLd(site)}
${(site.techMarkers ?? []).map((m) => `<!-- ${escapeHtml(m)} -->`).join("\n")}
${site.techMarkers?.includes("__NEXT_DATA__") ? '<script id="__NEXT_DATA__" type="application/json">{}</script>' : ""}
</head>
<body>
<header><h1>${escapeHtml(page.title)}</h1>${navFor(site)}</header>
<main>
${page.body.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")}
${extra}
${emails ? `<h2>Contact</h2><ul>${emails}</ul>` : ""}
</main>
<footer>
<address>${escapeHtml(site.address ?? "")}</address>
<p>&copy; ${new Date().getFullYear()} ${escapeHtml(site.host)}</p>
</footer>
</body>
</html>`;
}

export function createFixtureServer() {
  return createServer((req, res) => {
    const host = (req.headers.host ?? "").toLowerCase();
    const url = new URL(req.url ?? "/", `http://${host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const site = siteByHost(host);

    if (!site) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`No fixture site for host "${host}". Known: ${SITES.map((s) => s.host).join(", ")}`);
      return;
    }

    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(site.robots ?? "User-agent: *\nAllow: /\n");
      return;
    }

    const page = site.pages.find((p) => p.path === path);
    if (!page) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>Not found</title><h1>404</h1>");
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage(site, page));
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const server = createFixtureServer();
  server.listen(PORT, () => {
    console.log(`Fixture web serving ${SITES.length} sites on port ${PORT}`);
    for (const s of SITES) console.log(`  http://${s.host}:${PORT}/`);
  });
}
