"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";

export async function deleteDocument(id: string): Promise<{ error: string } | undefined> {
  const { supabase } = await requireUser();
  const { data: doc } = await supabase.from("documents").select("storage_path").eq("id", id).single();
  if (!doc) return { error: "Document not found. It may already have been deleted." };
  await supabase.storage.from("pdfs").remove([doc.storage_path]);
  const { error } = await supabase.from("documents").delete().eq("id", id); // RLS: own rows only; chunks/questions cascade
  if (error) return { error: "Could not delete the document. Please try again." };
  revalidatePath("/app");
}
