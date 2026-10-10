import { describe, expect, it } from "vitest";
import { checkDeliverability, mayContact } from "../src/core/deliverability";

const NOW = new Date("2026-03-10T09:00:00Z");

/**
 * Bounce rates of 20-40% are the documented reason AI SDR tools burn sending
 * domains. Every verdict here is a send we would otherwise have made.
 */
describe("checkDeliverability", () => {
  it("passes an individual address with MX records", () => {
    const check = checkDeliverability("lena@fableworks.test", { hasMx: true, errored: false }, NOW);
    expect(check.verdict).toBe("deliverable");
    expect(check.code).toBe("ok");
    expect(mayContact(check)).toBe(true);
  });

  it.each([
    "not-an-email", "lena@", "@fableworks.test", "lena@@fableworks.test",
    "lena fableworks.test", "lena@fableworks", "lena@.test",
  ])("rejects malformed address %s", (email) => {
    const check = checkDeliverability(email, undefined, NOW);
    expect(check.verdict).toBe("undeliverable");
    expect(check.code).toBe("syntax");
    expect(mayContact(check)).toBe(false);
  });

  it.each(["abuse@x.test", "postmaster@x.test", "noreply@x.test", "privacy@x.test", "security@x.test", "dpo@x.test"])(
    "never contacts %s",
    (email) => {
      const check = checkDeliverability(email, { hasMx: true, errored: false }, NOW);
      expect(check.code).toBe("never_contact");
      expect(mayContact(check)).toBe(false);
    },
  );

  it("rejects disposable mailbox providers", () => {
    const check = checkDeliverability("x@mailinator.com", { hasMx: true, errored: false }, NOW);
    expect(check.code).toBe("disposable");
    expect(mayContact(check)).toBe(false);
  });

  it("rejects a domain with no MX records", () => {
    const check = checkDeliverability("lena@parked.test", { hasMx: false, errored: false }, NOW);
    expect(check.verdict).toBe("undeliverable");
    expect(check.code).toBe("no_mx");
  });

  it("treats a DNS failure as risky, not undeliverable", () => {
    // We do not know the address is bad; we know we could not look. Marking
    // it undeliverable would suppress a good lead forever on a network blip.
    const check = checkDeliverability("lena@fableworks.test", { hasMx: false, errored: true, detail: "ETIMEOUT" }, NOW);
    expect(check.verdict).toBe("risky");
    expect(check.code).toBe("dns_error");
    expect(mayContact(check)).toBe(true);
  });

  it("marks a role inbox risky but contactable", () => {
    const check = checkDeliverability("hello@fableworks.test", { hasMx: true, errored: false }, NOW);
    expect(check.verdict).toBe("risky");
    expect(check.code).toBe("role_inbox");
    expect(mayContact(check)).toBe(true);
  });

  it("flags wrong-department inboxes as never-contact", () => {
    for (const email of ["careers@x.test", "jobs@x.test", "press@x.test", "billing@x.test"]) {
      expect(checkDeliverability(email, { hasMx: true, errored: false }, NOW).code).toBe("never_contact");
    }
  });

  it("records when no MX lookup happened", () => {
    const check = checkDeliverability("lena@fableworks.test", undefined, NOW);
    expect(check.mxChecked).toBe(false);
    expect(check.code).toBe("unchecked");
    // Unchecked must still be sendable, or an offline agent sends nothing.
    expect(mayContact(check)).toBe(true);
  });

  it("refuses to send when no check was run at all", () => {
    expect(mayContact(undefined)).toBe(false);
  });

  it("is case-insensitive about never-contact local parts", () => {
    expect(checkDeliverability("NoReply@X.test", { hasMx: true, errored: false }, NOW).code).toBe("never_contact");
  });
});
