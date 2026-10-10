import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth";

export const metadata = { title: "Create an account" };

export default async function RegisterPage() {
  if (await getUserId()) redirect("/campaigns");
  return (
    <>
      <Nav />
      <main className="narrow" style={{ padding: "72px 24px" }}>
        <AuthForm mode="register" />
      </main>
    </>
  );
}
