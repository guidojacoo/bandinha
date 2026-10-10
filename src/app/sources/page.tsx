import { redirect } from "next/navigation";
import { readSession } from "../../lib/auth";
import { describeSources } from "../../infra/sources";
import { dnsAvailable } from "../../infra/dns";
import { MODELS } from "../../infra/llm";
import { smtpConfigFromEnv, imapConfigFromEnv } from "../../infra/transport";
import { Pill, SectionHead } from "../../components/ui";

export const dynamic = "force-dynamic";

/**
 * Where the leads come from, and what is honestly known about each source.
 *
 * The `proven` / `untested` distinction is on this page rather than buried in
 * the code because a source that silently returns nothing looks exactly like
 * an ICP with no market, and an operator chasing the wrong one of those will
 * waste an afternoon.
 */
export default async function SourcesPage() {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login");

  const sources = describeSources();
  const dns = await dnsAvailable();
  const hasLlm = Boolean((process.env.GROQ_API_KEY ?? "").trim());

  return (
    <main>
      <h1>Sources</h1>
      <p className="lede">
        No paid data vendor is involved anywhere. Every lead comes from a public registry, a public map, a page
        somebody already published, or a list you supplied. That is the whole argument of this project, and it
        is also its main limitation: free sources are partial, so the ICP picks the ones that can plausibly
        find it.
      </p>

      <section>
        <SectionHead title="Prospect discovery" note="tried in the order the ICP chose, until there are enough leads" />
        <div className="stack">
          {sources.map((source) => (
            <div className="card" key={source.id}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <strong style={{ fontSize: 14 }}>{source.label}</strong>
                <div className="tags">
                  <Pill tone={source.confidence === "proven" ? "good" : "warn"} dot>
                    {source.confidence === "proven" ? "proven" : "built, untested"}
                  </Pill>
                  <Pill tone={source.configured ? "neutral" : "warn"}>
                    {source.configured ? "configured" : "needs configuration"}
                  </Pill>
                </div>
              </div>
              <p style={{ fontSize: 13, marginBottom: source.needs ? 8 : 0 }}>{source.coverage}</p>
              {source.needs && (
                <p className="dim mono" style={{ fontSize: 11, marginBottom: 0 }}>{source.needs}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <SectionHead title="What 'untested' means here" />
        <div className="card">
          <p style={{ fontSize: 13 }}>
            Three sources are complete and unproven. They were written on a machine whose network could reach
            the npm registry and nothing else: GitHub's API was scoped to a single repository, every Overpass
            mirror was unreachable, and so was every public SearXNG instance. The endpoints, their rate limits
            and their response shapes are public and stable — what has not been exercised is this code against
            them.
          </p>
          <p style={{ fontSize: 13, marginBottom: 0 }}>
            They are labelled rather than hidden because the alternative is an operator concluding their market
            does not exist. Run <span className="mono">npm run discover</span> to find out which of them work
            from where you are.
          </p>
        </div>
      </section>

      <section>
        <SectionHead title="This machine" />
        <div className="card" style={{ padding: 0 }}>
          <table>
            <tbody>
              <tr>
                <td style={{ width: 160 }}><strong>Model</strong></td>
                <td>
                  {hasLlm
                    ? <>Groq, <span className="mono">{MODELS.large}</span> and <span className="mono">{MODELS.small}</span></>
                    : <span className="dim">No GROQ_API_KEY. Copy is written deterministically — blunter, still specific, still sourced.</span>}
                </td>
              </tr>
              <tr>
                <td><strong>DNS</strong></td>
                <td>
                  {dns
                    ? "MX lookups work, so the deliverability pre-flight verifies addresses."
                    : <span className="dim">No resolver here. Addresses are recorded as unchecked rather than assumed good or bad.</span>}
                </td>
              </tr>
              <tr>
                <td><strong>Sending</strong></td>
                <td>
                  {smtpConfigFromEnv()
                    ? <>SMTP configured. A campaign still has to be armed separately before anything is sent.</>
                    : <span className="dim">No SMTP. Every send is written to ./outbox as a .eml file.</span>}
                </td>
              </tr>
              <tr>
                <td><strong>Replies</strong></td>
                <td>
                  {imapConfigFromEnv()
                    ? "IMAP configured; replies are read from the mailbox."
                    : <span className="dim">No IMAP. Replies are read from ./inbox, which is how the fixture buyers work.</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
