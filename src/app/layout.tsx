import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Rainmaker — autonomous B2B sales", template: "%s · Rainmaker" },
  description:
    "Give it one URL. It learns what you sell, finds companies that would buy it, writes to them, handles the replies and works the pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
