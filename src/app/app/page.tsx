import { PLAN_LIMITS, checkUpload } from "@/lib/plans";
import { requireUser } from "@/lib/supabase/server";
import { getPlan } from "@/lib/usage";
import { DocumentList, type DocumentRow } from "./DocumentList";
import { UploadBox } from "./UploadBox";

export default async function DocumentsPage() {
  const { supabase, user } = await requireUser();
  const plan = await getPlan(supabase, user.id);
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, status, error, page_count, created_at")
    .order("created_at", { ascending: false });
  const documents = (data ?? []) as DocumentRow[];
  const limit = checkUpload(plan, { documentCount: documents.length, fileBytes: 1 });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Your documents</h1>
      <UploadBox userId={user.id} maxBytes={PLAN_LIMITS[plan].maxFileBytes} disabledReason={limit.ok ? undefined : limit.reason} />
      {error ? <p className="text-sm text-red-600">Could not load documents. Refresh to try again.</p> : <DocumentList documents={documents} />}
    </div>
  );
}
