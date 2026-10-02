"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function UploadBox({ userId, maxBytes, maxPages, disabledReason }: { userId: string; maxBytes: number; maxPages: number; disabledReason?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setError("");
    if (file.type !== "application/pdf") return setError("Please choose a PDF file.");
    if (file.size > maxBytes) return setError(`File is too large. Max ${maxBytes / 1024 / 1024} MB.`);

    setBusy(true);
    const supabase = createBrowserSupabase();
    const id = crypto.randomUUID();
    const path = `${userId}/${id}.pdf`;
    try {
      const { error: upErr } = await supabase.storage.from("pdfs").upload(path, file, { contentType: "application/pdf" });
      if (upErr) throw new Error(upErr.message);
      const { error: insErr } = await supabase.from("documents").insert({ id, title: file.name.replace(/\.pdf$/i, "").slice(0, 200) || "Untitled", storage_path: path, size_bytes: file.size });
      if (insErr) {
        await supabase.storage.from("pdfs").remove([path]).catch(() => undefined);
        throw new Error(insErr.message);
      }
      router.refresh();
      const res = await fetch(`/api/documents/${id}/process`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Processing failed (${res.status}).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !disabledReason && !busy) upload(f); }}
      className="rounded-xl border-2 border-dashed border-indigo-200 bg-white p-8 text-center"
    >
      <p className="font-medium">{busy ? "Uploading and indexing…" : "Drop a PDF here"}</p>
      <p className="mt-1 text-sm text-gray-500">Max {maxBytes / 1024 / 1024} MB · up to {maxPages} pages · text-based PDFs only</p>
      <button
        type="button" disabled={busy || !!disabledReason} onClick={() => input.current?.click()}
        className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        Choose file
      </button>
      <input ref={input} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
      {disabledReason && <p className="mt-3 text-sm text-amber-700">{disabledReason}</p>}
      {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}
