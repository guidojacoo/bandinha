"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The one input.
 *
 * Everything below the URL is optional: without a sender identity the agent
 * still researches, qualifies and drafts — it simply cannot transmit, and
 * says so. That keeps the first run genuinely one field.
 */
export function NewCampaignForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [postalAddress, setPostalAddress] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          senderName: senderName.trim() || undefined,
          senderEmail: senderEmail.trim() || undefined,
          postalAddress: postalAddress.trim() || undefined,
          meetingLink: meetingLink.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.error ?? "Could not create the campaign.");
      router.push(`/campaigns/${body.campaignId}`);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack" style={{ gap: 16 }} onSubmit={submit}>
      <div>
        <h2 style={{ fontSize: 17 }}>Point it at what you sell</h2>
        <p className="small muted" style={{ marginTop: 5 }}>
          Your own website. It reads that, then goes looking for buyers.
        </p>
      </div>

      {error && <div className="alert" data-tone="error" role="alert">{error}</div>}

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input className="input mono" style={{ flex: "1 1 280px" }} required type="url"
          placeholder="https://your-company.com" value={url} spellCheck={false}
          onChange={(e) => setUrl(e.target.value)} aria-label="Your website URL" />
        <button className="btn" type="submit" disabled={busy || !url.trim()}>
          {busy ? "Creating…" : "Start"}
        </button>
      </div>

      <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }}
        onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Hide" : "Add"} sender details {open ? "▲" : "▼"}
      </button>

      {open && (
        <div className="stack" style={{ gap: 13 }}>
          <p className="hint">
            Required before anything can be transmitted. Commercial email must carry a real
            postal address and an identifiable sender, so the agent refuses to send without them.
          </p>
          <div className="field">
            <label className="label" htmlFor="sn">Sender name</label>
            <input id="sn" className="input" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="se">Sender email</label>
            <input id="se" className="input mono" type="email" value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="pa">Postal address</label>
            <input id="pa" className="input" value={postalAddress}
              onChange={(e) => setPostalAddress(e.target.value)}
              placeholder="12 Dock Road, Bristol BS1 6RR, United Kingdom" />
          </div>
          <div className="field">
            <label className="label" htmlFor="ml">Meeting link <span className="faint">(optional)</span></label>
            <input id="ml" className="input mono" value={meetingLink}
              onChange={(e) => setMeetingLink(e.target.value)} placeholder="https://cal.com/you/30min" />
          </div>
        </div>
      )}
    </form>
  );
}
