"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: "◆" },
  { href: "/sleep", label: "Sleep", icon: "☾" },
  { href: "/health", label: "Health", icon: "♡" },
  { href: "/trends", label: "Trends", icon: "▲" },
  { href: "/devices", label: "Devices", icon: "◈" },
  { href: "/alarms", label: "Alarms", icon: "◷" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function NavLinks({ variant }: { variant: "side" | "bottom" }) {
  const pathname = usePathname();

  return (
    <nav className={variant === "side" ? "stack" : "row"} style={variant === "side" ? { gap: 4 } : { justifyContent: "space-around", width: "100%" }}>
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname?.startsWith(link.href + "/");
        return (
          <Link
            key={link.href}
            href={link.href}
            className="row"
            style={{
              gap: 10,
              padding: variant === "side" ? "10px 14px" : "6px 10px",
              borderRadius: 12,
              textDecoration: "none",
              color: active ? "var(--accent)" : "var(--text-muted)",
              background: active ? "var(--accent-soft)" : "transparent",
              fontWeight: 600,
              fontSize: variant === "side" ? 14 : 11,
              flexDirection: variant === "side" ? "row" : "column",
            }}
          >
            <span aria-hidden style={{ fontSize: variant === "side" ? 16 : 18 }}>{link.icon}</span>
            <span>{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
