import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "../src/infra/db";
import { GET, POST } from "../src/app/api/unsubscribe/[token]/route";
import { mintToken, optOutUrl } from "../src/core/optout";

/**
 * The endpoint that makes the footer's promise real.
 *
 * Before this existed, every message told its recipient how to stop and
 * pointed at a URL nothing served. CAN-SPAM §7704(a)(3) requires the
 * mechanism to work for at least thirty days; Gmail's bulk-sender rules
 * require the one-click POST to be honoured.
 */

const SECRET = "a-test-secret-long-enough-to-pass";
let userId = "";

async function get(token: string) {
  return GET(new Request(`http://localhost/api/unsubscribe/${token}`), {
    params: Promise.resolve({ token }),
  });
}

async function post(token: string) {
  return POST(new Request(`http://localhost/api/unsubscribe/${token}`, { method: "POST" }), {
    params: Promise.resolve({ token }),
  });
}

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: "optout-test@mercurio.test" },
    create: { email: "optout-test@mercurio.test", passwordHash: await bcrypt.hash("x".repeat(12), 4) },
    update: {},
  });
  userId = user.id;
});

beforeEach(async () => {
  process.env.AUTH_SECRET = SECRET;
  await db.suppression.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: "optout-test@mercurio.test" } });
  await db.$disconnect();
});

describe("a person clicking the link", () => {
  it("suppresses immediately and says so", async () => {
    const token = mintToken({ userId, email: "lena@fableworks.test" }, SECRET);
    const response = await get(token);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toMatch(/You have been unsubscribed/);
    expect(html).toContain("lena@fableworks.test");

    const suppression = await db.suppression.findUnique({
      where: { userId_email: { userId, email: "lena@fableworks.test" } },
    });
    expect(suppression?.reason).toBe("unsubscribed");
  });

  it("does not ask them to confirm first", async () => {
    // Given a choice between occasionally suppressing an address nobody meant
    // to and occasionally continuing to mail somebody who tried to stop it,
    // this errs toward the first. One lost lead against a complaint.
    const token = mintToken({ userId, email: "lena@fableworks.test" }, SECRET);
    await get(token);
    expect(await db.suppression.count({ where: { userId } })).toBe(1);
  });

  it("is idempotent, and says which it was", async () => {
    const token = mintToken({ userId, email: "lena@fableworks.test" }, SECRET);
    await get(token);
    const second = await get(token);

    expect(await second.text()).toMatch(/Already unsubscribed/);
    expect(await db.suppression.count({ where: { userId } })).toBe(1);
  });

  it("tells them the reply path still works when the link is bad", async () => {
    // A truncated link is the common failure, and it has a working remedy
    // that does not depend on this page.
    const response = await get("not-a-real-token");
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/Reply to the message with the word <strong>unsubscribe<\/strong>/);
  });

  it("escapes the address rather than reflecting it into the page", async () => {
    const token = mintToken({ userId, email: '"><script>alert(1)</script>@x.test' }, SECRET);
    const html = await (await get(token)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("asks search engines not to index it", async () => {
    const token = mintToken({ userId, email: "lena@fableworks.test" }, SECRET);
    expect(await (await get(token)).text()).toMatch(/name="robots" content="noindex/);
  });

  it("is not cached, so a back button does not show a stale answer", async () => {
    const token = mintToken({ userId, email: "lena@fableworks.test" }, SECRET);
    expect((await get(token)).headers.get("cache-control")).toMatch(/no-store/);
  });
});

describe("Gmail's one-click POST", () => {
  it("suppresses and answers 200", async () => {
    const token = mintToken({ userId, email: "paulo@meridianpay.test" }, SECRET);
    const response = await post(token);

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(await db.suppression.count({ where: { userId } })).toBe(1);
  });

  it("answers 200 even for a bad token, because a retry cannot fix one", async () => {
    // A non-2xx makes Gmail retry, and retrying a malformed token forever
    // helps nobody.
    const response = await post("garbage");
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(false);
  });
});

describe("forged and foreign tokens", () => {
  it("does nothing for a token signed with another secret", async () => {
    const token = mintToken({ userId, email: "lena@fableworks.test" }, "a-different-secret");
    expect((await get(token)).status).toBe(400);
    expect(await db.suppression.count({ where: { userId } })).toBe(0);
  });

  it("cannot be used to enumerate anything", async () => {
    // Unsigned ids on an unauthenticated route are an enumeration oracle:
    // feed it ids until one stops 404ing and you have a customer list. Every
    // invalid token gets the same answer.
    const first = await get("aaaa.bbbb");
    const second = await get("cccc.dddd");
    expect(first.status).toBe(second.status);
    expect(await first.text()).toBe(await second.text());
  });

  it("refuses everything when the server has no signing secret", async () => {
    const token = mintToken({ userId, email: "lena@fableworks.test" }, SECRET);
    delete process.env.AUTH_SECRET;

    const response = await get(token);
    expect(response.status).toBe(400);
    // And it points at the path that does not depend on this route.
    expect(await response.text()).toMatch(/unsubscribe/i);
    expect(await db.suppression.count({ where: { userId } })).toBe(0);
  });
});

describe("the link in a footer", () => {
  it("round-trips from the URL a message carries", async () => {
    process.env.PUBLIC_BASE_URL = "https://mail.acme.test";
    const url = optOutUrl({ userId, email: "sofie@atlasgrid.test" }, {
      baseUrl: process.env.PUBLIC_BASE_URL,
      secret: SECRET,
    });
    expect(url).toBeTruthy();

    // Exactly what a recipient's browser would do with it.
    const token = new URL(url!).pathname.split("/").pop()!;
    expect((await get(token)).status).toBe(200);
    expect(await db.suppression.count({ where: { userId } })).toBe(1);

    delete process.env.PUBLIC_BASE_URL;
  });
});
