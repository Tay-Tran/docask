import Link from "next/link";
import { PLAN_LIMITS } from "@/lib/plans";
import { requireUser } from "@/lib/supabase/server";
import { countDocuments, countQuestionsToday, getPlan } from "@/lib/usage";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const { supabase, user } = await requireUser();
  const [plan, docs, questions] = await Promise.all([getPlan(supabase, user.id), countDocuments(supabase), countQuestionsToday(supabase)]);
  const limits = PLAN_LIMITS[plan];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link href="/app" className="font-semibold text-indigo-700">DocAsk</Link>
          <p className="text-xs text-gray-600">
            {docs}/{limits.maxDocuments} documents · {questions}/{limits.questionsPerDay} questions today ·{" "}
            <span className="font-medium uppercase">{plan}</span>
          </p>
          <form action="/auth/signout" method="post">
            <button className="text-sm text-gray-600 hover:text-gray-900">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
