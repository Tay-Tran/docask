import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { Chat, type Turn } from "./Chat";

export default async function DocPage(props: PageProps<"/app/doc/[id]">) {
  const { id } = await props.params;
  const { supabase } = await requireUser();
  const { data: doc } = await supabase.from("documents").select("id, title, status, page_count").eq("id", id).single();
  if (!doc || doc.status !== "ready") notFound();

  const { data: history } = await supabase
    .from("questions")
    .select("question, answer, sources, mode")
    .eq("document_id", id)
    .neq("answer", "")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-4">
      <Link href="/app" className="text-sm text-indigo-700 hover:underline">← All documents</Link>
      <h1 className="text-2xl font-semibold">{doc.title}</h1>
      <p className="text-sm text-gray-500">{doc.page_count} pages</p>
      <Chat documentId={doc.id} initial={[...((history ?? []) as Turn[])].reverse()} />
    </div>
  );
}
