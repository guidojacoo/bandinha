import Link from "next/link";
import { getUserId } from "@/lib/auth/session";
import { LogoutButton } from "./LogoutButton";
import { Logo } from "./Logo";
import { NavLinks } from "./NavLinks";

export async function Nav() {
  const userId = await getUserId();

  return (
    <nav className="nav">
      <div className="container nav-inner">
        <Link href={userId ? "/dashboard" : "/"} className="brand">
          <Logo />
          <span>Bitrot</span>
        </Link>

        <div className="nav-links">
          {userId ? (
            <>
              <NavLinks
                items={[
                  { href: "/dashboard", label: "Dashboard" },
                  { href: "/scan", label: "New scan" },
                  { href: "/check", label: "Check a package" },
                ]}
              />
              <LogoutButton />
            </>
          ) : (
            <>
              <NavLinks
                items={[
                  { href: "/check", label: "Check a package" },
                  { href: "/login", label: "Sign in" },
                ]}
              />
              <Link href="/register" className="btn btn-sm" style={{ marginLeft: 6 }}>
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
