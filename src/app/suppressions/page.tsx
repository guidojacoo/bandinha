import { redirect } from "next/navigation";
import { db } from "../../infra/db";
import { readSession } from "../../lib/auth";
import { suppress, unsuppress } from "../actions";
import { Empty, Pill, SectionHead, ago } from "../../components/ui";

export const dynamic = "force-dynamic";

const REASON_TONE: Record<string, "bad" | "warn" | "neutral"> = {
  unsubscribed: "bad",
  complained: "bad",
  hard_bounce: "warn",
  undeliverable: "warn",
  not_interested: "neutral",
  manual: "neutral",
};

/**
 * The do-not-contact list.
 *
 * Global per operator, not per campaign, and that is the important part:
 * someone who opts out of one campaign is out of every campaign, for good.
 * A per-campaign suppression list is how people end up receiving the same
 * pitch from the same company three times under three different subject
 * lines.
 */
export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login");

  const params = await searchParams;
  const suppressions = await db.suppression.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main>
      <h1>Suppressions</h1>
      <p className="lede">
        Checked before every send, ahead of every other rule — including when the agent is answering a question
        somebody asked. This list is global and permanent: an opt-out from one campaign applies to all of them.
      </p>

      {params.error === "email" && <div className="banner bad">That does not look like an email address.</div>}

      <div className="grid split">
        <section>
          <SectionHead title={`${suppressions.length} address(es)`} />
          {suppressions.length === 0 ? (
            <Empty>Nobody has asked to be left alone yet.</Empty>
          ) : (
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Reason</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {suppressions.map((entry) => (
                    <tr key={entry.id}>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {entry.email}
                        {entry.note && <span className="reason">{entry.note}</span>}
                      </td>
                      <td><Pill tone={REASON_TONE[entry.reason] ?? "neutral"}>{entry.reason.replace(/_/g, " ")}</Pill></td>
                      <td className="dim nowrap">{ago(entry.createdAt)}</td>
                      <td>
                        {entry.reason === "manual" ? (
                          <form action={unsuppress}>
                            <input type="hidden" name="id" value={entry.id} />
                            <button className="ghost" type="submit">Remove</button>
                          </form>
                        ) : (
                          <span className="dim" style={{ fontSize: 11 }}>
                            {/* An opt-out is not an operator preference to revisit. */}
                            permanent
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <SectionHead title="Add one by hand" />
          <div className="card">
            <form action={suppress}>
              <div className="field">
                <label htmlFor="email">Email address</label>
                <input id="email" name="email" type="email" placeholder="someone@example.com" required />
              </div>
              <div className="field">
                <label htmlFor="note">Note</label>
                <input id="note" name="note" type="text" placeholder="asked by phone not to be contacted" />
              </div>
              <button type="submit">Add</button>
            </form>
            <p className="dim" style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
              Only entries added here can be removed. Suppressions the agent created from an opt-out, a
              complaint or a hard bounce are permanent, because undoing one means contacting somebody who
              asked not to be.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
