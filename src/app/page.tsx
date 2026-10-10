import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth";
import { transportStatus } from "@/infra/transport";
import { llm } from "@/infra/llm/client";

export const dynamic = "force-dynamic";

const STAGES = [
  { n: "1", t: "Reads your site", d: "Crawls it the way a person would — pricing, product, customers, about — and extracts what you sell, what you can prove, and how you write." },
  { n: "2", t: "Works out who buys it", d: "Derives an ideal customer profile: industries, size, the titles that hold budget, and the words a company with this problem has on its own website." },
  { n: "3", t: "Finds those companies", d: "Directories, search and seed lists. Each candidate gets crawled and scored on evidence, not on a domain name." },
  { n: "4", t: "Writes to them", d: "Every message opens with something real it found on their site. Nothing it cannot trace back to your own pages can appear in the copy." },
  { n: "5", t: "Handles the replies", d: "Classifies interest, objections, referrals and opt-outs. Answers the winnable ones from a playbook, escalates the rest." },
  { n: "6", t: "Works the pipeline", d: "Pauses cadences on reply, books meetings, moves stages, and stops the moment someone asks it to." },
];

export default async function LandingPage() {
  if (await getUserId()) redirect("/campaigns");

  return (
    <>
      <Nav />
      <main>
        <section className="container" style={{ padding: "76px 24px 56px" }}>
          <div style={{ maxWidth: 680 }}>
            <span className="badge" data-tone="accent">One URL in. A pipeline out.</span>
            <h1 style={{ fontSize: "clamp(32px, 5vw, 50px)", marginTop: 20, lineHeight: 1.05 }}>
              An autonomous sales agent that{" "}
              <span style={{ color: "var(--accent)" }}>actually reads the room.</span>
            </h1>
            <p className="muted" style={{ fontSize: 17.5, marginTop: 20, maxWidth: 580 }}>
              Give Rainmaker the address of the thing you sell. It learns the product, works out who
              buys it, finds those companies, writes to them about something true it found on their
              own site, and handles what comes back — on its own, on a loop.
            </p>
            <div className="row" style={{ gap: 11, marginTop: 28, flexWrap: "wrap" }}>
              <Link href="/register" className="btn">Start a campaign</Link>
              <Link href="/login" className="btn btn-secondary">Sign in</Link>
            </div>
          </div>
        </section>

        <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-inset)" }}>
          <div className="container" style={{ padding: "60px 24px" }}>
            <h2 style={{ fontSize: "clamp(21px, 3vw, 27px)" }}>What it does, unattended</h2>
            <div className="grid" style={{ marginTop: 28, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {STAGES.map((s) => (
                <div key={s.n} className="card card-tight card-hover">
                  <div className="row" style={{ gap: 10 }}>
                    <span className="mono tiny" style={{ color: "var(--accent)" }}>{s.n}</span>
                    <h3 style={{ fontSize: 15 }}>{s.t}</h3>
                  </div>
                  <p className="small muted" style={{ marginTop: 8 }}>{s.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="container" style={{ padding: "60px 24px 80px" }}>
          <div className="card" style={{ maxWidth: 760 }}>
            <h2 style={{ fontSize: 19 }}>What it will not do</h2>
            <p className="small muted" style={{ marginTop: 12 }}>
              It will not mail anyone on your suppression list, anyone who asked it to stop, an
              abuse or security address, or anyone at all until a lawful sender identity with a real
              postal address exists. It holds a reply back for a human whenever it is not confident,
              whenever a thread has gone too many rounds, and whenever money or a signature is
              involved. And it never marks its own deals won — that takes a payment, a signature, or
              a person.
            </p>
            <p className="small muted" style={{ marginTop: 12 }}>
              Not squeamishness: unsolicited bulk mail to harvested addresses is unlawful in most of
              the world and burns the sending domain within hours, after which even the wanted mail
              stops arriving.
            </p>
          </div>

          <div className="row small faint" style={{ gap: 18, marginTop: 24, flexWrap: "wrap" }}>
            <span>Sending: {transportStatus()}</span>
            <span>Model: {llm().enabled ? llm().model : "none configured — deterministic fallbacks"}</span>
          </div>
        </section>
      </main>
    </>
  );
}
