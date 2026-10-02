"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { deleteDocument } from "./actions";

export type DocumentRow = { id: string; title: string; status: "processing" | "ready" | "failed"; error: string | null; page_count: number | null; created_at: string };

const badge = {
  processing: "bg-amber-100 text-amber-800",
  ready: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
} as const;

export function DocumentList({ documents }: { documents: DocumentRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function retry(id: string) {
    setError("");
    setRetrying(id);
    try {
      const res = await fetch(`/api/documents/${id}/process`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Processing failed (${res.status}).`);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setRetrying(null);
      router.refresh();
    }
  }

  function remove(d: DocumentRow) {
    if (!confirm(`Delete "${d.title}"?`)) return;
    setError("");
    startTransition(async () => {
      try {
        await deleteDocument(d.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delete failed.");
      }
    });
  }

  // Poll while anything is processing.
  useEffect(() => {
    if (!documents.some((d) => d.status === "processing")) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [documents, router]);

  if (documents.length === 0) {
    return (
      <>
        {error && <p className="mb-3 text-sm text-red-600" role="alert">{error}</p>}
        <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-500">No documents yet. Upload a PDF to start asking questions.</p>
      </>
    );
  }

  return (
    <>
    {error && <p className="mb-3 text-sm text-red-600" role="alert">{error}</p>}
    <ul className="divide-y rounded-xl bg-white shadow-sm">
      {documents.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            {d.status === "ready" ? (
              <Link href={`/app/doc/${d.id}`} className="break-words font-medium text-indigo-700 hover:underline">{d.title}</Link>
            ) : (
              <span className="break-words font-medium">{d.title}</span>
            )}
            <p className="text-xs text-gray-500">
              {d.page_count ? `${d.page_count} pages · ` : ""}{new Date(d.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}
            </p>
            {d.status === "failed" && d.error && <p className="mt-1 text-sm text-red-600">{d.error}</p>}
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge[d.status]}`}>{d.status}</span>
          {d.status === "failed" && (
            <button
              disabled={retrying === d.id}
              onClick={() => retry(d.id)}
              className="text-sm text-indigo-700 hover:underline disabled:opacity-50"
            >
              {retrying === d.id ? "Retrying…" : "Retry"}
            </button>
          )}
          <button
            disabled={pending}
            onClick={() => remove(d)}
            className="text-sm text-gray-500 hover:text-red-600"
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
    </>
  );
}
