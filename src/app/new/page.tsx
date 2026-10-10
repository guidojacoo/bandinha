import { redirect } from "next/navigation";
import { readSession } from "../../lib/auth";
import { createCampaign } from "../actions";
import { MODELS } from "../../infra/llm";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login");

  const params = await searchParams;
  const hasLlm = Boolean((process.env.GROQ_API_KEY ?? "").trim());

  return (
    <main>
      <h1>New campaign</h1>
      <p className="lede">
        Paste the website of whatever you are selling. The agent reads it, works out the offer and the buyer,
        and sets up the pipeline. Reading a dozen pages takes ten to thirty seconds, so this page will sit
        and think for a moment.
      </p>

      {params.error === "ingest" && (
        <div className="banner bad">
          <div>
            <strong>Could not read that site.</strong>
            <div style={{ marginTop: 4 }}>{params.detail ?? "No readable pages were found."}</div>
          </div>
        </div>
      )}
      {params.error === "sender" && (
        <div className="banner bad">
          A name, an email address and a postal address are all required. Commercial email has to identify a
          real sender at a real postal address, and the agent refuses to send without one.
        </div>
      )}
      {params.error === "url" && <div className="banner bad">A URL is required.</div>}

      {!hasLlm && (
        <div className="banner">
          <div>
            <strong>No GROQ_API_KEY set.</strong>{" "}
            Everything still works — the offer, the ICP and the copy are derived deterministically instead of
            written by a model. Set the key to use <span className="mono">{MODELS.large}</span> on Groq's free
            tier.
          </div>
        </div>
      )}

      <form action={createCampaign}>
        <div className="grid split">
          <div className="card">
            <h2>What you sell</h2>
            <div className="field">
              <label htmlFor="url">Your website <span className="req">*</span></label>
              <input id="url" name="url" type="url" placeholder="https://your-company.com" required />
              <div className="help">The agent reads this site and nothing else to work out your offer.</div>
            </div>

            <h2 style={{ marginTop: 26 }}>Who the mail comes from</h2>
            <div className="field">
              <label htmlFor="fromName">Your name <span className="req">*</span></label>
              <input id="fromName" name="fromName" type="text" placeholder="Dana Reyes" required />
            </div>
            <div className="field">
              <label htmlFor="fromEmail">Your email <span className="req">*</span></label>
              <input id="fromEmail" name="fromEmail" type="email" placeholder="dana@your-company.com" required />
              <div className="help">Replies come back here, so it has to be a mailbox you read.</div>
            </div>
            <div className="field">
              <label htmlFor="postalAddress">Postal address <span className="req">*</span></label>
              <input
                id="postalAddress"
                name="postalAddress"
                type="text"
                placeholder="Your Company Ltd, 4 Dock Street, Bristol BS1 4RU, United Kingdom"
                required
              />
              <div className="help">
                Required on commercial email by CAN-SPAM §7704(a)(5) and its equivalents. It goes in the footer
                of every message, and the agent will not send a message without it.
              </div>
            </div>
            <div className="field">
              <label htmlFor="unsubscribeUrl">Unsubscribe URL</label>
              <input id="unsubscribeUrl" name="unsubscribeUrl" type="url" placeholder="https://your-company.com/unsubscribe" />
              <div className="help">
                Optional, and strongly recommended. Without it the footer falls back to asking people to reply,
                and Gmail and Yahoo both throttle bulk mail that carries no one-click unsubscribe header.
              </div>
            </div>
            <div className="field">
              <label htmlFor="meetingLink">Booking link</label>
              <input id="meetingLink" name="meetingLink" type="url" placeholder="https://cal.com/you/15min" />
            </div>
          </div>

          <div>
            <div className="card">
              <h2>How hard to work it</h2>
              <div className="field">
                <label htmlFor="targetLeads">Leads to work</label>
                <input id="targetLeads" name="targetLeads" type="number" min={1} max={500} defaultValue={25} />
                <div className="help">The agent stops discovering once this many are enrolled.</div>
              </div>
              <div className="field">
                <label htmlFor="minFitScore">Minimum fit score</label>
                <input id="minFitScore" name="minFitScore" type="number" min={0} max={100} defaultValue={55} />
                <div className="help">
                  Below this, a lead is rejected with its reason recorded. 55 is a reasonable start; raise it if
                  the leads look thin.
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 14 }}>
              <h3>Nothing is sent yet</h3>
              <p style={{ fontSize: 12, marginBottom: 0 }}>
                New campaigns start in dry run. Messages are written to{" "}
                <span className="mono">./outbox</span> so you can read exactly what would have gone out. Live
                sending needs SMTP configured and a separate, typed confirmation.
              </p>
            </div>

            <div className="actions" style={{ marginTop: 18 }}>
              <button type="submit">Read the site and set up</button>
              <a className="button ghost" href="/">Cancel</a>
            </div>
          </div>
        </div>
      </form>
    </main>
  );
}
