"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((i) => (
        <Link key={i.href} href={i.href} className="nav-link"
          data-active={pathname === i.href || pathname.startsWith(`${i.href}/`)}>
          {i.label}
        </Link>
      ))}
    </>
  );
}
