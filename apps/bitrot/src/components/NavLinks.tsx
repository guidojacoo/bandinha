"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="nav-link"
          data-active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
        >
          {item.label}
        </Link>
      ))}
    </>
  );
}
