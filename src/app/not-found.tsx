import Link from "next/link";
import { Nav } from "@/components/Nav";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="narrow" style={{ padding: "96px 24px" }}>
        <div className="card" style={{ textAlign: "center", padding: "48px 26px" }}>
          <div className="mono faint tiny" style={{ letterSpacing: ".1em" }}>404</div>
          <h1 style={{ fontSize: 23, marginTop: 10 }}>Nothing here</h1>
          <p className="muted" style={{ maxWidth: 360, margin: "12px auto 0" }}>
            That page does not exist — or it belongs to a different account.
          </p>
          <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
            <Link href="/campaigns" className="btn">Campaigns</Link>
          </div>
        </div>
      </main>
    </>
  );
}
