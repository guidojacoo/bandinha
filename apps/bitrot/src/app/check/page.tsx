import { Nav } from "@/components/Nav";
import { PackageCheck } from "@/components/PackageCheck";

export const metadata = {
  title: "Check a package",
  description:
    "Paste an npm or PyPI package name and get its lifecycle risk score from live registry data. No account needed.",
};

export default function CheckPage() {
  return (
    <>
      <Nav />
      <main className="container-narrow" style={{ padding: "56px 24px 80px" }}>
        <div className="stack" style={{ gap: 22 }}>
          <div>
            <h1 style={{ fontSize: 27 }}>Check a package</h1>
            <p className="muted" style={{ marginTop: 10 }}>
              One name, one score, straight from the registry. This is the check Snyk Advisor used
              to serve — no account, no install.
            </p>
          </div>
          <PackageCheck autoFocus />
        </div>
      </main>
    </>
  );
}
