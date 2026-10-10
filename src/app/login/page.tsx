import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getUserId()) redirect("/campaigns");
  return (
    <>
      <Nav />
      <main className="narrow" style={{ padding: "72px 24px" }}>
        <AuthForm mode="login" />
      </main>
    </>
  );
}
