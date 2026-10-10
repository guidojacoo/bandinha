import Link from "next/link";
import { getUserId } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";
import { Logo } from "./Logo";
import { NavLinks } from "./NavLinks";

export async function Nav() {
  const userId = await getUserId();
  return (
    <nav className="nav">
      <div className="container nav-inner">
        <Link href={userId ? "/campaigns" : "/"} className="brand">
          <Logo />
          <span>Rainmaker</span>
        </Link>
        <div className="nav-links">
          {userId ? (
            <>
              <NavLinks items={[{ href: "/campaigns", label: "Campaigns" }]} />
              <LogoutButton />
            </>
          ) : (
            <>
              <NavLinks items={[{ href: "/login", label: "Sign in" }]} />
              <Link href="/register" className="btn btn-sm" style={{ marginLeft: 6 }}>Get started</Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
