import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { ScanForm } from "@/components/ScanForm";
import { getUserId } from "@/lib/auth/session";

export const metadata = { title: "New scan" };

export default async function ScanPage() {
  if (!(await getUserId())) redirect("/login");

  return (
    <>
      <Nav />
      <main className="container-narrow" style={{ padding: "48px 24px 80px" }}>
        <div className="stack" style={{ gap: 24 }}>
          <div>
            <h1 style={{ fontSize: 27 }}>New scan</h1>
            <p className="muted" style={{ marginTop: 10 }}>
              Every dependency is resolved against the live registry and scored on eight lifecycle
              signals.
            </p>
          </div>
          <ScanForm />
        </div>
      </main>
    </>
  );
}
