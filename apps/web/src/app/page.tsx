import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/authServer";

export default async function HomePage() {
  const user = await getSessionUser();
  redirect(user ? "/dashboard" : "/login");
}
