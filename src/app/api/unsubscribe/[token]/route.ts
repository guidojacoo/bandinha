import { NextResponse } from "next/server";
import { db, logEvent } from "../../../../infra/db";
import { normaliseEmail, readToken } from "../../../../core/optout";

/**
 * The opt-out endpoint.
 *
 * Two methods, because two different things follow a link in an email:
 *
 *  - **POST** is Gmail and Yahoo. Since 2024 their bulk-sender rules require
 *    one-click unsubscribe, which means the `List-Unsubscribe-Post` header
 *    this project already sends has to be honoured by something that accepts
 *    a POST and acts on it. It gets a bare 200; nobody reads the body.
 *  - **GET** is a person clicking. It suppresses *and then* confirms, rather
 *    than asking them to confirm first.
 *
 * That second decision is worth stating. A confirmation step means a
 * prefetcher or a link scanner cannot unsubscribe somebody by accident, and
 * it also means a person who closes the tab is still subscribed. Given a
 * choice between occasionally suppressing an address nobody meant to suppress
 * and occasionally continuing to mail somebody who tried to stop it, this
 * errs toward the first every time. The cost of being wrong in that direction
 * is one lost lead. The cost of being wrong in the other is a complaint, a
 * reputation hit, and having ignored somebody who asked.
 *
 * Suppression is global and permanent, exactly as it is when the agent reads
 * "unsubscribe" in a reply. There is no per-campaign opt-out, because
 * somebody who opts out of one campaign has opted out.
 */

export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  const result = await suppress(token);

  // A one-click handler's job is to be unfailingly boring. Gmail retries a
  // non-2xx, and a bad token is not something a retry fixes.
  return NextResponse.json({ ok: result.ok, status: result.status }, { status: result.ok ? 200 : 200 });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const result = await suppress(token);

  return new Response(page(result), {
    status: result.ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

type Outcome =
  | { ok: true; email: string; status: "suppressed" | "already" }
  | { ok: false; status: "bad_token" | "unavailable" };

async function suppress(token: string): Promise<Outcome> {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (!secret) return { ok: false, status: "unavailable" };

  const read = readToken(token, secret);
  if (!read.ok) return { ok: false, status: "bad_token" };

  const email = normaliseEmail(read.subject.email);

  try {
    const existing = await db.suppression.findUnique({
      where: { userId_email: { userId: read.subject.userId, email } },
    });
    if (existing) return { ok: true, email, status: "already" };

    await db.suppression.create({
      data: {
        userId: read.subject.userId,
        email,
        reason: "unsubscribed",
        note: "Clicked the unsubscribe link.",
      },
    });

    // Logged against every campaign that has written to this address, so the
    // operator sees it where they would look for it.
    const campaigns = await db.campaign.findMany({
      where: { userId: read.subject.userId, messages: { some: { toEmail: email } } },
      select: { id: true },
    });
    for (const campaign of campaigns) {
      await logEvent(campaign.id, "optout.link", `${email} unsubscribed through the link in a message.`, {
        level: "warn",
      });
    }

    return { ok: true, email, status: "suppressed" };
  } catch {
    // A database that is down must not make the opt-out look like a bad link.
    return { ok: false, status: "unavailable" };
  }
}

/**
 * The confirmation page.
 *
 * Self-contained, no framework, no fonts, no tracking — a page somebody sees
 * once, at the moment they have decided they want nothing more from us, is
 * not a place to load anything or ask anything. It states what happened and
 * stops.
 */
function page(result: Outcome): string {
  const { heading, body } = copy(result);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f9; color: #15181e;
  }
  main { max-width: 32rem; background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 28px 30px; }
  h1 { font-size: 19px; margin: 0 0 10px; letter-spacing: -0.01em; }
  p { margin: 0 0 12px; color: #4a5160; }
  p:last-child { margin-bottom: 0; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: #f0f2f5; padding: 1px 5px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0c0e12; color: #e7eaf0; }
    main { background: #14171d; border-color: #262b34; }
    p { color: #9aa3b2; }
    code { background: #1c2128; }
  }
</style>
</head>
<body>
  <main>
    <h1>${heading}</h1>
    ${body}
  </main>
</body>
</html>
`;
}

function copy(result: Outcome): { heading: string; body: string } {
  if (result.ok && result.status === "suppressed") {
    return {
      heading: "You have been unsubscribed",
      body: `<p><code>${escapeHtml(result.email)}</code> has been removed, and will not be contacted again.</p>
    <p>This applies to everything sent from here, not just the message you clicked from, and it is permanent — there is no re-subscribe link, by design.</p>`,
    };
  }
  if (result.ok) {
    return {
      heading: "Already unsubscribed",
      body: `<p><code>${escapeHtml(result.email)}</code> was already on the do-not-contact list. Nothing further will be sent.</p>`,
    };
  }
  if (result.status === "unavailable") {
    return {
      heading: "Something went wrong at our end",
      body: `<p>Your link is fine — we could not record the change just now.</p>
    <p>Rather than ask you to try again: reply to the message with the word <strong>unsubscribe</strong> and it will be handled automatically. That path does not depend on this page working.</p>`,
    };
  }
  return {
    heading: "This link is not valid",
    body: `<p>It may have been truncated by an email client, which happens to long links.</p>
    <p>Reply to the message with the word <strong>unsubscribe</strong> instead — that works, and it does not depend on the link surviving.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}
