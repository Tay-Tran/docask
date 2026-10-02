import type { SupabaseClient } from "@supabase/supabase-js";
import type { Plan } from "./plans";

export async function getPlan(supabase: SupabaseClient, userId: string): Promise<Plan> {
  const { data } = await supabase.from("profiles").select("plan").eq("id", userId).single();
  return (data?.plan as Plan) ?? "free";
}

export async function countDocuments(supabase: SupabaseClient): Promise<number> {
  const { count } = await supabase.from("documents").select("id", { count: "exact", head: true });
  return count ?? 0;
}

export async function countQuestionsToday(supabase: SupabaseClient): Promise<number> {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startOfDayUtc.toISOString());
  return count ?? 0;
}
