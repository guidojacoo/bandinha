import { redirect } from "next/navigation";
import { db } from "../../infra/db";
import { readSession } from "../../lib/auth";
import { MIN_SENDS_PER_VALUE, rate } from "../../core/learning";
import { reportFor, headline } from "../../agent/learning";
import { Empty, Metric, Pill, SectionHead } from "../../components/ui";

export const dynamic = "force-dynamic";

/**
 * What is working, and what cannot be told apart yet.
 *
 * The page is built around the second half of that sentence. Every other
 * analytics screen in this category shows a ranked list of percentages and
 * lets the reader assume the order means something; at the volumes this
 * product deliberately sends at, it usually does not. So a value below the
 * sample threshold is shown with its counts and no rate at all, and a
 * comparison whose intervals overlap says so instead of picking a winner.
 */
export default async function LearningPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login");

  const params = await searchParams;
  const campaigns = await db.campaign.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  if (campaigns.length === 0) {
    return (
      <main>
        <h1>What is working</h1>
        <Empty>No campaigns yet. <a href="/new">Start one</a>.</Empty>
      </main>
    );
  }

  const campaign = campaigns.find((c) => c.id === params.campaign) ?? campaigns[0]!;
  const [{ reports, briefLines }, numbers] = await Promise.all([
    reportFor(campaign.id),
    headline(campaign.id),
  ]);

  return (
    <main>
      <h1>What is working</h1>
      <p className="lede">
        The quality scorer measures whether copy <em>looks</em> like copy that gets replies. This measures
        whether it <em>did</em> — which is a different question, because the scorer encodes what is known about
        cold email in general and your market is specific.
      </p>

      {campaigns.length > 1 && (
        <div className="tags" style={{ marginBottom: 20 }}>
          {campaigns.map((option) => (
            <a key={option.id} href={`/learning?campaign=${option.id}`}>
              <Pill tone={option.id === campaign.id ? "info" : "neutral"} dot={option.id === campaign.id}>
                {option.name}
              </Pill>
            </a>
          ))}
        </div>
      )}

      <section>
        <div className="grid cols-4">
          <Metric value={numbers.contacted} label="Prospects contacted" hint="not messages — a sequence is one attempt" />
          <Metric
            value={numbers.contacted === 0 ? "—" : rate(numbers.replyRate)}
            label="Replied"
            hint={`${numbers.replied} of ${numbers.contacted}`}
            tone={numbers.replyRate >= 0.04 ? "good" : undefined}
          />
          <Metric
            value={numbers.contacted === 0 ? "—" : rate(numbers.positiveRate)}
            label="Replied usefully"
            hint={`${numbers.positive} interested, asking or booking`}
            tone={numbers.positiveRate > 0 ? "good" : undefined}
          />
          <Metric value="4%+" label="Good, for cold email" hint="human-written benchmark" />
        </div>
      </section>

      {briefLines.length > 0 && (
        <section>
          <SectionHead title="Fed back into the copy" note="only findings that hold up are passed to the composer" />
          <div className="card">
            {briefLines.map((line, index) => (
              <div className="claim" key={index}>
                <span className="text">{line}</span>
              </div>
            ))}
            <p className="dim" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              Passed as context, not as an instruction. A fourteen-send coincidence must not become the house
              style, so a finding whose samples overlap is left out of this entirely.
            </p>
          </div>
        </section>
      )}

      {reports.map((report) => (
        <section key={report.dimension}>
          <SectionHead title={report.label} />
          <p className="dim" style={{ fontSize: 12, marginTop: -6, marginBottom: 12, maxWidth: "72ch" }}>
            {report.note}
          </p>

          {report.tooEarly ? (
            <Empty>{report.tooEarly}</Empty>
          ) : (
            <>
              <div className="card" style={{ padding: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Value</th>
                      <th className="num">Contacted</th>
                      <th className="num">Replied</th>
                      <th className="num">Usefully</th>
                      <th>Reply rate</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.findings.map((finding) => (
                      <tr key={finding.value}>
                        <td style={{ fontWeight: finding.verdict === "strong" ? 600 : 400 }}>{finding.value}</td>
                        <td className="num">{finding.sent}</td>
                        <td className="num">{finding.replies}</td>
                        <td className="num">{finding.positives}</td>
                        <td>
                          {finding.verdict === "too_early" ? (
                            <span className="dim" style={{ fontSize: 12 }}>
                              {/* Deliberately no percentage: showing one here is how a
                                  dashboard ends up recommending whatever is newest. */}
                              not enough to say
                            </span>
                          ) : (
                            <span className="mono">
                              {rate(finding.replyRate)}
                              <span className="dim" style={{ fontSize: 11 }}> (at worst {rate(finding.lowerBound)})</span>
                            </span>
                          )}
                        </td>
                        <td>
                          <Pill
                            tone={
                              finding.verdict === "strong" ? "good"
                                : finding.verdict === "working" ? "info"
                                  : finding.verdict === "weak" ? "warn" : "neutral"
                            }
                          >
                            {finding.verdict === "too_early" ? `under ${MIN_SENDS_PER_VALUE} sends` : finding.verdict}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.recommendation && (
                <p
                  className={report.recommendation.includes("not enough to call it") ? "dim" : ""}
                  style={{ fontSize: 13, marginTop: 12, maxWidth: "78ch" }}
                >
                  {report.recommendation}
                </p>
              )}
            </>
          )}
        </section>
      ))}

      <section>
        <SectionHead title="Why this is not an A/B test" />
        <div className="card">
          <p style={{ fontSize: 13 }}>
            A proper experiment needs hundreds of sends per arm. The volume caps here are deliberately low,
            because volume is what destroys senders — so this measures attributes of messages that were sent
            anyway, which finds correlation and cannot establish cause.
          </p>
          <p style={{ fontSize: 13, marginBottom: 0 }}>
            In practice that is usually enough to act on: if prospects who wrote about on-call pain reply and
            prospects who merely mention Kubernetes do not, the right move is to change the ICP whether or not
            the mechanism is proven. But a finding here is a reason to look, not a result.
          </p>
        </div>
      </section>
    </main>
  );
}
