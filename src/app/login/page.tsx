import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const { data } = await (await createClient()).auth.getUser();
  if (data.user) redirect("/app");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold">Sign in to DocAsk</h1>
      <p className="mb-6 mt-2 text-sm text-gray-600">We&apos;ll email you a one-time sign-in link. No password needed.</p>
      <LoginForm />
    </main>
  );
}
