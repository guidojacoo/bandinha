import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth/session";

export const metadata = { title: "Create an account" };

export default async function RegisterPage() {
  if (await getUserId()) redirect("/dashboard");

  return (
    <>
      <Nav />
      <main className="auth-wrap">
        <AuthForm mode="register" />
        <p className="tiny faint" style={{ textAlign: "center" }}>
          An account stores your scans so you can track rot over time. Single-package checks stay{" "}
          <Link href="/check" className="link">
            free and account-less
          </Link>
          .
        </p>
      </main>
    </>
  );
}
