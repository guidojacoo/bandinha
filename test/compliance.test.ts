import { describe, expect, it } from "vitest";
import { buildFooter, evaluateSend, isInsideWindow, nextWindowOpening, senderIdentityProblems } from "../src/core/compliance";
import { checkDeliverability } from "../src/core/deliverability";
import type { SendAttempt } from "../src/core/types";
import { compliance, sender } from "./factories";

const OK_MX = { hasMx: true, errored: false };
const TUESDAY_10AM = new Date("2026-03-10T10:00:00Z");

function attempt(over: Partial<SendAttempt> = {}): SendAttempt {
  return {
    toEmail: "lena@fableworks.test",
    now: TUESDAY_10AM,
    sentToday: 0,
    sentTodayToDomain: 0,
    suppressed: false,
    deliverability: checkDeliverability("lena@fableworks.test", OK_MX, TUESDAY_10AM),
    ...over,
  };
}

/**
 * These are the rules that make the difference between outreach and
 * harassment, and between lawful commercial mail and an offence. Every one of
 * them is a reason the agent will refuse to send.
 */
describe("evaluateSend", () => {
  it("allows a clean first touch inside the window", () => {
    expect(evaluateSend(attempt(), compliance())).toEqual({ allowed: true });
  });

  it("refuses to send without a lawful sender identity", () => {
    const config = compliance({ sender: { ...sender, postalAddress: "" } });
    const decision = evaluateSend(attempt(), config);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("missing_sender_identity");
  });

  it("refuses an address with no deliverability pre-flight", () => {
    // Fails closed: forgetting to wire the check up must not silently turn
    // the whole pre-flight into a no-op.
    const decision = evaluateSend(attempt({ deliverability: undefined }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("undeliverable");
  });

  it("refuses an address the pre-flight called undeliverable", () => {
    const decision = evaluateSend(attempt({
      toEmail: "lena@parked.test",
      deliverability: checkDeliverability("lena@parked.test", { hasMx: false, errored: false }, TUESDAY_10AM),
    }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("undeliverable");
  });

  it("honours suppression above every other rule", () => {
    const decision = evaluateSend(
      attempt({ suppressed: true, suppressionReason: "unsubscribed", isReply: true }),
      compliance(),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("suppressed");
  });

  it("blocks a domain on the blocklist", () => {
    const decision = evaluateSend(attempt({
      toEmail: "someone@blocked.test",
      deliverability: checkDeliverability("someone@blocked.test", OK_MX, TUESDAY_10AM),
    }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("blocked_domain");
  });

  it("blocks a subdomain of a blocked domain", () => {
    const decision = evaluateSend(attempt({
      toEmail: "someone@mail.blocked.test",
      deliverability: checkDeliverability("someone@mail.blocked.test", OK_MX, TUESDAY_10AM),
    }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("blocked_domain");
  });

  it("enforces the anti-pester gap on cold touches", () => {
    const decision = evaluateSend(
      attempt({ lastTouchedAt: new Date("2026-03-10T08:00:00Z") }),
      compliance(),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("too_soon");
      expect(decision.retryAt).toBeInstanceOf(Date);
    }
  });

  it("never gags a reply with the anti-pester gap", () => {
    // A prospect who asks a question at 10am must not be met with 48 hours of
    // silence because of a cold-cadence throttle.
    const decision = evaluateSend(
      attempt({ lastTouchedAt: new Date("2026-03-10T09:30:00Z"), isReply: true }),
      compliance(),
    );
    expect(decision.allowed).toBe(true);
  });

  it("never gags a reply with the per-domain cap", () => {
    const decision = evaluateSend(attempt({ sentTodayToDomain: 9, isReply: true }), compliance());
    expect(decision.allowed).toBe(true);
  });

  it("still enforces the global daily cap on replies", () => {
    // The global cap protects the sending reputation of the whole domain; a
    // reply storm is still a reputation event.
    const decision = evaluateSend(attempt({ sentToday: 40, isReply: true }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("daily_cap");
  });

  it("enforces the per-domain cap on cold touches", () => {
    const decision = evaluateSend(attempt({ sentTodayToDomain: 2 }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("domain_cap");
  });

  it("refuses to send outside business hours and says when it can", () => {
    const decision = evaluateSend(attempt({ now: new Date("2026-03-10T23:00:00Z") }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("outside_window");
      expect(decision.retryAt!.getTime()).toBeGreaterThan(new Date("2026-03-10T23:00:00Z").getTime());
    }
  });

  it("refuses to send at the weekend", () => {
    const saturday = new Date("2026-03-14T10:00:00Z");
    const decision = evaluateSend(attempt({ now: saturday }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("outside_window");
  });

  it("rejects an abuse address even if everything else is clean", () => {
    const decision = evaluateSend(attempt({
      toEmail: "abuse@fableworks.test",
      deliverability: checkDeliverability("abuse@fableworks.test", OK_MX, TUESDAY_10AM),
    }), compliance());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("invalid_recipient");
  });
});

describe("isInsideWindow", () => {
  it("respects the configured timezone offset", () => {
    // 23:00 UTC is 09:00 the next day in Tokyo: inside the window there.
    const tokyo = compliance({ timezoneOffsetMinutes: 540 });
    expect(isInsideWindow(new Date("2026-03-10T23:00:00Z"), tokyo)).toBe(true);
    expect(isInsideWindow(new Date("2026-03-10T23:00:00Z"), compliance())).toBe(false);
  });
});

describe("nextWindowOpening", () => {
  it("lands inside the window from any starting point", () => {
    const config = compliance();
    for (const iso of ["2026-03-10T23:00:00Z", "2026-03-14T10:00:00Z", "2026-03-15T03:00:00Z", "2026-03-10T06:00:00Z"]) {
      const opening = nextWindowOpening(new Date(iso), config);
      expect(isInsideWindow(opening, config)).toBe(true);
      expect(opening.getTime()).toBeGreaterThan(new Date(iso).getTime());
    }
  });
});

describe("senderIdentityProblems", () => {
  it("accepts a complete identity", () => {
    expect(senderIdentityProblems(sender)).toEqual([]);
  });

  it("names every missing part", () => {
    const problems = senderIdentityProblems({ fromName: "", fromEmail: "nope", postalAddress: "" });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildFooter", () => {
  it("carries the sender, a postal address and a way out", () => {
    const footer = buildFooter(sender);
    expect(footer).toContain(sender.postalAddress);
    expect(footer.toLowerCase()).toMatch(/unsubscribe|reply/);
  });
});
