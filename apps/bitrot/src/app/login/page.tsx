import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getUserId()) redirect("/dashboard");

  return (
    <>
      <Nav />
      <main className="auth-wrap">
        <AuthForm mode="login" />
        <p className="tiny faint" style={{ textAlign: "center" }}>
          Checking a single package needs no account —{" "}
          <Link href="/check" className="link">
            try that first
          </Link>
          .
        </p>
      </main>
    </>
  );
}
