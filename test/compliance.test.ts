import { describe, expect, it } from "vitest";
import {
  buildFooter, domainOf, evaluateSend, hasOptOut, isInsideWindow, isNeverContact,
  isRoleInbox, isValidEmail, nextWindowOpening, senderIdentityProblems,
} from "../src/core/compliance";
import type { SendAttempt } from "../src/core/types";
import { NOW, complianceConfig } from "./fixtures";

function attempt(over: Partial<SendAttempt> = {}): SendAttempt {
  return {
    toEmail: "priya@hoverboard.example",
    now: NOW,
    sentToday: 0,
    sentTodayToDomain: 0,
    suppressed: false,
    ...over,
  };
}

describe("address handling", () => {
  it("accepts ordinary addresses and rejects malformed ones", () => {
    expect(isValidEmail("a.b+tag@sub.example.co.uk")).toBe(true);
    for (const bad of ["", "no-at-sign", "a@b", "a@@b.com", "a b@c.com", `${"x".repeat(250)}@y.com`]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });

  it("identifies shared role inboxes", () => {
    expect(isRoleInbox("info@x.com")).toBe(true);
    expect(isRoleInbox("sales@x.com")).toBe(true);
    expect(isRoleInbox("priya@x.com")).toBe(false);
  });

  it("refuses to ever contact abuse, security and no-reply addresses", () => {
    for (const e of ["abuse@x.com", "postmaster@x.com", "security@x.com", "privacy@x.com",
                     "noreply@x.com", "no-reply@x.com", "dpo@x.com", "abuse+reports@x.com"]) {
      expect(isNeverContact(e), e).toBe(true);
    }
    expect(isNeverContact("priya@x.com")).toBe(false);
  });

  it("extracts the domain", () => {
    expect(domainOf("Priya@Hoverboard.Example")).toBe("hoverboard.example");
  });
});

describe("sender identity", () => {
  it("requires a name, a valid address and a real postal address", () => {
    expect(senderIdentityProblems(complianceConfig().sender)).toEqual([]);
    // CAN-SPAM §7704(a)(5) makes the postal address non-optional.
    const noAddress = senderIdentityProblems({ ...complianceConfig().sender, postalAddress: "" });
    expect(noAddress.join(" ")).toMatch(/postalAddress/);
  });

  it("blocks every send when the sender identity is incomplete", () => {
    const config = complianceConfig({
      sender: { ...complianceConfig().sender, postalAddress: "" },
    });
    const decision = evaluateSend(attempt(), config);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("missing_sender_identity");
  });
});

describe("evaluateSend", () => {
  it("allows a clean send inside the window", () => {
    expect(evaluateSend(attempt(), complianceConfig()).allowed).toBe(true);
  });

  it("blocks a suppressed recipient", () => {
    const d = evaluateSend(attempt({ suppressed: true, suppressionReason: "unsubscribed" }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("suppressed");
  });

  /**
   * Suppression must beat every other consideration. An earlier ordering
   * checked caps first, so an unsubscribed address inside a quiet period was
   * reported as "outside window" — and would have been retried later.
   */
  it("reports suppression even when other rules would also block", () => {
    const d = evaluateSend(
      attempt({ suppressed: true, now: new Date("2026-03-07T23:00:00Z"), sentToday: 999 }),
      complianceConfig(),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("suppressed");
  });

  it("blocks blocked domains and their subdomains", () => {
    for (const to of ["x@competitor.example", "x@mail.competitor.example"]) {
      const d = evaluateSend(attempt({ toEmail: to }), complianceConfig());
      expect(d.allowed, to).toBe(false);
      if (!d.allowed) expect(d.code).toBe("blocked_domain");
    }
  });

  it("blocks never-contact addresses", () => {
    const d = evaluateSend(attempt({ toEmail: "abuse@hoverboard.example" }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("invalid_recipient");
  });

  it("enforces the minimum gap between touches and says when to retry", () => {
    const d = evaluateSend(
      attempt({ lastTouchedAt: new Date(NOW.getTime() - 3600_000) }),
      complianceConfig(),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.code).toBe("too_soon");
      expect(d.retryAt!.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("allows the send once the minimum gap has elapsed", () => {
    const d = evaluateSend(
      attempt({ lastTouchedAt: new Date(NOW.getTime() - 72 * 3600_000) }),
      complianceConfig(),
    );
    expect(d.allowed).toBe(true);
  });

  it("enforces the workspace daily cap", () => {
    const d = evaluateSend(attempt({ sentToday: 50 }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("daily_cap");
  });

  it("enforces the per-domain daily cap so one company is never carpet-bombed", () => {
    const d = evaluateSend(attempt({ sentTodayToDomain: 2 }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("domain_cap");
  });

  it("refuses to send outside the window and schedules the retry inside it", () => {
    const sat = new Date("2026-03-07T12:00:00Z"); // Saturday
    const d = evaluateSend(attempt({ now: sat }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.code).toBe("outside_window");
      expect(isInsideWindow(d.retryAt!, complianceConfig())).toBe(true);
    }
  });
});

describe("replies are exempt from cadence throttles", () => {
  /**
   * Regression: a warm prospect asked a pricing question and the agent's
   * answer was blocked as `too_soon`, because the 48h cold-outreach gap was
   * being applied to a reply. The deal sat silent and died.
   */
  it("answers a prospect who just wrote, despite the minimum gap", () => {
    const base = attempt({ lastTouchedAt: new Date(NOW.getTime() - 3600_000) });
    expect(evaluateSend(base, complianceConfig()).allowed).toBe(false);
    expect(evaluateSend({ ...base, isReply: true }, complianceConfig()).allowed).toBe(true);
  });

  it("ignores the per-domain cap for replies", () => {
    const base = attempt({ sentTodayToDomain: 99 });
    expect(evaluateSend(base, complianceConfig()).allowed).toBe(false);
    expect(evaluateSend({ ...base, isReply: true }, complianceConfig()).allowed).toBe(true);
  });

  it("still refuses to reply to someone who opted out", () => {
    const d = evaluateSend(attempt({ isReply: true, suppressed: true, suppressionReason: "unsubscribed" }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("suppressed");
  });

  it("still respects the workspace daily cap for replies", () => {
    const d = evaluateSend(attempt({ isReply: true, sentToday: 50 }), complianceConfig());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("daily_cap");
  });
});

describe("send window", () => {
  const config = complianceConfig();

  it("is open on a weekday inside business hours and closed otherwise", () => {
    expect(isInsideWindow(new Date("2026-03-04T09:00:00Z"), config)).toBe(true);
    expect(isInsideWindow(new Date("2026-03-04T16:59:00Z"), config)).toBe(true);
    expect(isInsideWindow(new Date("2026-03-04T17:00:00Z"), config)).toBe(false);
    expect(isInsideWindow(new Date("2026-03-04T08:59:00Z"), config)).toBe(false);
    expect(isInsideWindow(new Date("2026-03-07T12:00:00Z"), config)).toBe(false); // Sat
    expect(isInsideWindow(new Date("2026-03-08T12:00:00Z"), config)).toBe(false); // Sun
  });

  it("respects the sending locale's offset rather than assuming UTC", () => {
    // 12:00 UTC is 09:00 in UTC-3 — inside a 9-17 local window.
    const buenosAires = complianceConfig({ timezoneOffsetMinutes: -180 });
    expect(isInsideWindow(new Date("2026-03-04T12:00:00Z"), buenosAires)).toBe(true);
    expect(isInsideWindow(new Date("2026-03-04T11:00:00Z"), buenosAires)).toBe(false);
  });

  it("finds the next opening across a weekend", () => {
    const next = nextWindowOpening(new Date("2026-03-06T18:00:00Z"), config); // Fri evening
    expect(isInsideWindow(next, config)).toBe(true);
    expect(next.getUTCDay()).toBe(1); // Monday
  });

  it("always returns a time that is actually inside the window", () => {
    for (const iso of ["2026-03-04T03:00:00Z", "2026-03-07T12:00:00Z", "2026-03-08T23:30:00Z"]) {
      const next = nextWindowOpening(new Date(iso), config);
      expect(isInsideWindow(next, config), iso).toBe(true);
      expect(next.getTime()).toBeGreaterThan(new Date(iso).getTime());
    }
  });
});

describe("footer", () => {
  it("carries the sender, a postal address and a way out", () => {
    const footer = buildFooter(complianceConfig().sender);
    expect(footer).toContain("Sam Okafor");
    expect(footer).toContain("Bristol");
    expect(hasOptOut(footer)).toBe(true);
  });

  it("offers a reply-based opt-out when no unsubscribe URL is configured", () => {
    const footer = buildFooter({ ...complianceConfig().sender, unsubscribeUrl: undefined });
    expect(hasOptOut(footer)).toBe(true);
  });
});
