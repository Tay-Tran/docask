import { NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkPages } from "@/lib/chunking";
import { embedTexts, EmbedError } from "@/lib/embed";
import { checkPages, checkUpload } from "@/lib/plans";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { STALE_AFTER_MS } from "@/lib/stale";
import { countDocuments, getPlan } from "@/lib/usage";

export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/documents/[id]/process">) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const { data: session } = await supabase.auth.getSession();
  if (!auth.user || !session.session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const userId = auth.user.id;
  const body = await req.json().catch(() => null);
  const isRetry = body?.retry === true;

  // RLS: returns the row only if the caller owns it.
  const { data: doc } = await supabase
    .from("documents")
    .select("id, storage_path, size_bytes, status, page_count")
    .eq("id", id)
    .single();
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // Never re-index a ready document.
  if (doc.status === "ready") return NextResponse.json({ status: "ready", pageCount: doc.page_count });

  const admin = createAdminClient();
  const fail = async (status: number, message: string) => {
    await admin.from("documents").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status });
  };

  try {
    // Atomic claim on retry: only one caller can move failed -> processing.
    // An explicit retry may also take over a row stuck in processing for over 2 minutes
    // (timeout or dropped request). First-time runs (no retry flag) are never claimed.
    if (doc.status === "failed" || isRetry) {
      let claimed: { id: string }[] | null = null;
      const failedClaim = await admin
        .from("documents")
        .update({ status: "processing", error: null })
        .eq("id", id)
        .eq("user_id", userId)
        .eq("status", "failed")
        .select("id");
      claimed = failedClaim.data;
      if ((!claimed || claimed.length === 0) && isRetry) {
        const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
        const staleClaim = await admin
          .from("documents")
          .update({ status: "processing", error: null })
          .eq("id", id)
          .eq("user_id", userId)
          .eq("status", "processing")
          .lt("created_at", cutoff)
          .select("id");
        claimed = staleClaim.data;
      }
      if (!claimed || claimed.length === 0) return NextResponse.json({ error: "Already processing" }, { status: 409 });
    }

    const plan = await getPlan(supabase, userId);
    // The new row is already counted, so compare against count - 1.
    const countCheck = checkUpload(plan, { documentCount: (await countDocuments(supabase)) - 1, fileBytes: 0 });
    if (!countCheck.ok) return fail(403, countCheck.reason);

    const { data: file, error: downloadError } = await supabase.storage.from("pdfs").download(doc.storage_path);
    if (downloadError || !file) return fail(400, "Could not read the uploaded file. Please upload it again.");

    // Use the real downloaded size, not the client-supplied size_bytes.
    const sizeCheck = checkUpload(plan, { documentCount: 0, fileBytes: file.size });
    if (!sizeCheck.ok) return fail(403, sizeCheck.reason);

    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
      // Reject over-limit PDFs before the expensive text extraction.
      const earlyPageCheck = checkPages(plan, pdf.numPages);
      if (!earlyPageCheck.ok) return fail(403, earlyPageCheck.reason);
      pages = (await extractText(pdf, { mergePages: false })).text;
    } catch {
      return fail(400, "This file could not be read as a PDF.");
    }

    const pageCheck = checkPages(plan, pages.length);
    if (!pageCheck.ok) return fail(403, pageCheck.reason);

    const chunks = chunkPages(pages);
    if (chunks.length === 0) return fail(400, "No text found – this may be a scanned PDF. Scanned documents are not supported.");

    let embeddings: number[][];
    try {
      embeddings = await embedTexts(chunks.map((c) => c.content), session.session.access_token);
    } catch (error) {
      return fail(502, error instanceof EmbedError ? "Indexing service failed. Please retry." : "Unexpected error while indexing.");
    }
    if (embeddings.length !== chunks.length) return fail(502, "Indexing service returned an unexpected result. Please retry.");

    const { error: deleteError } = await admin.from("chunks").delete().eq("document_id", id); // safe re-run on retry
    if (deleteError) return fail(500, "Could not save the document index. Please retry.");
    const rows = chunks.map((c, i) => ({ document_id: id, user_id: userId, page: c.page, content: c.content, embedding: JSON.stringify(embeddings[i]) }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from("chunks").insert(rows.slice(i, i + 200));
      if (error) return fail(500, "Could not save the document index. Please retry.");
    }

    const { error: readyError } = await admin.from("documents").update({ status: "ready", page_count: pages.length, error: null }).eq("id", id);
    if (readyError) return fail(500, "Could not finalize the document. Please retry.");
    return NextResponse.json({ status: "ready", pageCount: pages.length });
  } catch {
    return fail(500, "Unexpected error while processing. Please retry.");
  }
}
