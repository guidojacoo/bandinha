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
      <main className="container-narrow" style={{ padding: "70px 24px" }}>
        <AuthForm mode="register" />
      </main>
    </>
  );
}
