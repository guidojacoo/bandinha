import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Bitrot — find the dependencies that stopped having a maintainer",
    template: "%s · Bitrot",
  },
  description:
    "Your scanner finds CVEs. Bitrot finds the other half of the risk: dependencies that are deprecated, abandoned, or one maintainer away from unmaintained. Live npm and PyPI registry data, no signup to check a single package.",
  openGraph: {
    title: "Bitrot — dependency lifecycle risk, scored",
    description:
      "Paste a package.json or requirements.txt. Get a prioritised list of the dependencies that are rotting.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
