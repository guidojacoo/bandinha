import Link from "next/link";
import { Nav } from "@/components/Nav";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="container-narrow" style={{ padding: "96px 24px" }}>
        <div className="card" style={{ textAlign: "center", padding: "52px 26px" }}>
          <div className="mono faint" style={{ fontSize: 13, letterSpacing: "0.1em" }}>
            404
          </div>
          <h1 style={{ fontSize: 24, marginTop: 12 }}>Nothing here</h1>
          <p className="muted" style={{ maxWidth: 380, margin: "12px auto 0" }}>
            That page does not exist — or it belongs to a different account.
          </p>
          <div className="row" style={{ justifyContent: "center", gap: 10, marginTop: 26 }}>
            <Link href="/" className="btn btn-secondary">
              Home
            </Link>
            <Link href="/check" className="btn">
              Check a package
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
