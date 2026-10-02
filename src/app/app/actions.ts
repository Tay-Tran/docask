"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";

export async function deleteDocument(id: string) {
  const { supabase } = await requireUser();
  const { data: doc } = await supabase.from("documents").select("storage_path").eq("id", id).single();
  if (!doc) return;
  await supabase.storage.from("pdfs").remove([doc.storage_path]);
  await supabase.from("documents").delete().eq("id", id); // RLS: own rows only; chunks/questions cascade
  revalidatePath("/app");
}
