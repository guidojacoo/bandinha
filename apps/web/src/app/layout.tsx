import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "H59 Health",
  description: "A modern, self-hosted replacement for QWatch Pro.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
