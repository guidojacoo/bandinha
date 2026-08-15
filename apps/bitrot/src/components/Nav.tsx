import Link from "next/link";
import { getUserId } from "@/lib/auth/session";
import { LogoutButton } from "./LogoutButton";
import { Logo } from "./Logo";

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
          <Link href="/check" className="nav-link">
            Check a package
          </Link>
          {userId ? (
            <>
              <Link href="/dashboard" className="nav-link">
                Dashboard
              </Link>
              <Link href="/scan" className="nav-link">
                New scan
              </Link>
              <LogoutButton />
            </>
          ) : (
            <>
              <Link href="/login" className="nav-link">
                Sign in
              </Link>
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
