import { describe, expect, it } from "vitest";
import { mintToken, normaliseEmail, optOutUrl, readToken } from "../src/core/optout";

const SECRET = "a-secret-long-enough-to-be-plausible";
const SUBJECT = { userId: "user_abc", email: "lena@fableworks.test" };

/**
 * The one part of a cold email that is legally load-bearing. CAN-SPAM
 * §7704(a)(3) requires a working mechanism for at least thirty days, and
 * Gmail's bulk-sender rules require the one-click POST to be honoured — a
 * header advertising one-click that then 404s is worse than no header.
 */
describe("tokens", () => {
  it("round-trips a recipient", () => {
    const result = readToken(mintToken(SUBJECT, SECRET), SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.subject).toEqual(SUBJECT);
  });

  it("normalises the address, so case and spacing cannot create a second identity", () => {
    const token = mintToken({ userId: "user_abc", email: "  LENA@Fableworks.TEST " }, SECRET);
    const result = readToken(token, SECRET);
    if (result.ok) expect(result.subject.email).toBe("lena@fableworks.test");
  });

  it("refuses a token signed with a different secret", () => {
    const result = readToken(mintToken(SUBJECT, "another-secret"), SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Signature/);
  });

  it("refuses a tampered payload", () => {
    // The attack: swap the address and keep the signature.
    const token = mintToken(SUBJECT, SECRET);
    const [, signature] = token.split(".");
    const forged = `${Buffer.from("user_abc:someone-else@elsewhere.test", "utf8").toString("base64url")}.${signature}`;
    expect(readToken(forged, SECRET).ok).toBe(false);
  });

  it("refuses a tampered signature", () => {
    const [payload] = mintToken(SUBJECT, SECRET).split(".");
    expect(readToken(`${payload}.not-the-signature`, SECRET).ok).toBe(false);
  });

  it.each(["", "   ", "nodot", "a.b.c", ".", "..", "x."])("refuses the malformed token %o", (token) => {
    expect(readToken(token, SECRET).ok).toBe(false);
  });

  it("refuses a correctly-signed token carrying no address", () => {
    // Signing is necessary and not sufficient: the payload still has to
    // contain something that identifies a person.
    const payload = Buffer.from("user_abc:not-an-address", "utf8").toString("base64url");
    const token = mintToken({ userId: "user_abc", email: "x@y.test" }, SECRET);
    const [, signature] = token.split(".");
    expect(readToken(`${payload}.${signature}`, SECRET).ok).toBe(false);
  });

  it("gives different recipients different tokens", () => {
    // A shared link cannot tell who clicked it, and an opt-out that cannot
    // identify its subject is not an opt-out.
    const a = mintToken(SUBJECT, SECRET);
    const b = mintToken({ ...SUBJECT, email: "paulo@meridianpay.test" }, SECRET);
    expect(a).not.toBe(b);
  });

  it("gives the same recipient the same token every time", () => {
    // Stable, so a link in an old message keeps working. Thirty days is the
    // legal floor, not a target, and "your unsubscribe link has expired" is
    // not a defensible sentence.
    expect(mintToken(SUBJECT, SECRET)).toBe(mintToken(SUBJECT, SECRET));
  });

  it("produces a token that survives being put in a URL", () => {
    const token = mintToken({ userId: "user_abc", email: "a+tag@fableworks.test" }, SECRET);
    expect(token).toBe(encodeURIComponent(token));
    expect(readToken(token, SECRET).ok).toBe(true);
  });
});

describe("optOutUrl", () => {
  it("builds a per-recipient link", () => {
    const url = optOutUrl(SUBJECT, { baseUrl: "https://mail.acme.test", secret: SECRET });
    expect(url).toMatch(/^https:\/\/mail\.acme\.test\/api\/unsubscribe\/[\w-]+\.[\w-]+$/);
  });

  it("tolerates a trailing slash on the base", () => {
    expect(optOutUrl(SUBJECT, { baseUrl: "https://mail.acme.test///", secret: SECRET }))
      .not.toMatch(/\/\/api/);
  });

  it("returns nothing rather than a guess when there is nowhere to point", () => {
    // A footer with no link falls back to "reply and I will remove you",
    // which works because the agent reads its replies. A link to a host that
    // is not serving this app is a promise nothing keeps.
    expect(optOutUrl(SUBJECT, {})).toBeNull();
    expect(optOutUrl(SUBJECT, { baseUrl: "https://mail.acme.test" })).toBeNull();
    expect(optOutUrl(SUBJECT, { secret: SECRET })).toBeNull();
    expect(optOutUrl(SUBJECT, { baseUrl: "   ", secret: SECRET })).toBeNull();
  });

  it("refuses a base that is not an absolute http URL", () => {
    for (const baseUrl of ["localhost:3000", "mail.acme.test", "/api", "javascript:alert(1)"]) {
      expect(optOutUrl(SUBJECT, { baseUrl, secret: SECRET }), baseUrl).toBeNull();
    }
  });
});

describe("normaliseEmail", () => {
  it("lowercases and trims", () => {
    expect(normaliseEmail("  Lena@Fableworks.TEST ")).toBe("lena@fableworks.test");
  });
});
