"use client";

import { useState } from "react";

type SourceRef = { n: number; page: number; content: string };
export type Turn = { question: string; answer: string; sources: SourceRef[]; mode: "ai" | "demo" };

const STARTERS = ["Summarize this document in 5 bullet points.", "What are the key dates or deadlines?", "What does it say about costs or fees?"];

export function Chat({ documentId, initial }: { documentId: string; initial: Turn[] }) {
  const [turns, setTurns] = useState<Turn[]>(initial);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<SourceRef | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setQuestion("");
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId, question: text }) });
    if (!res.ok || !res.body) {
      setError((await res.json().catch(() => ({}))).error ?? "Something went wrong.");
      setBusy(false);
      return;
    }
    // Placeholder turn so "Thinking…" shows before the first token arrives.
    setTurns((prev) => [...prev, { question: text, answer: "", sources: [], mode: "ai" }]);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let meta: { mode: Turn["mode"]; sources: SourceRef[] } | null = null;
    const index = turns.length;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (!meta) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) continue;
        meta = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
      const answer = buffer;
      setTurns((prev) => {
        const next = prev.slice(0, index);
        next.push({ question: text, answer, sources: meta!.sources, mode: meta!.mode });
        return next;
      });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      {turns.length === 0 && (
        <div className="rounded-xl bg-white p-4">
          <p className="text-sm text-gray-600">Try asking:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button key={s} onClick={() => ask(s)} className="rounded-full bg-indigo-50 px-3 py-1.5 text-sm text-indigo-800 hover:bg-indigo-100">{s}</button>
            ))}
          </div>
        </div>
      )}

      {turns.map((t, i) => (
        <div key={i} className="space-y-2">
          <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-indigo-600 px-4 py-2 text-white">{t.question}</p>
          <div className="max-w-[90%] rounded-2xl bg-white px-4 py-3 shadow-sm">
            {t.mode === "demo" && <p className="mb-2 text-xs font-medium text-amber-700">Demo mode</p>}
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {t.answer.split(/(\[\d+\])/g).map((part, j) => {
                const n = part.match(/^\[(\d+)\]$/)?.[1];
                const src = n ? t.sources.find((s) => s.n === Number(n)) : undefined;
                return src ? (
                  <button key={j} onClick={() => setOpen(src)} className="mx-0.5 rounded bg-indigo-100 px-1 text-xs font-medium text-indigo-800 hover:bg-indigo-200" title={`Page ${src.page}`}>
                    {part}
                  </button>
                ) : (
                  <span key={j}>{part}</span>
                );
              })}
              {busy && i === turns.length - 1 && t.answer === "" && <span className="text-gray-400">Thinking…</span>}
            </p>
          </div>
        </div>
      ))}

      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}

      <form onSubmit={(e) => { e.preventDefault(); ask(question); }} className="sticky bottom-0 flex gap-2 bg-gray-50 py-2">
        <input
          value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} placeholder="Ask about this document…"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        />
        <button disabled={busy || !question.trim()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy ? "…" : "Ask"}
        </button>
      </form>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setOpen(null)}>
          <div className="max-h-[70vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:max-w-lg sm:rounded-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Source ${open.n}`}>
            <p className="text-xs font-medium text-indigo-700">Source [{open.n}] · page {open.page}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm">{open.content}</p>
            <button onClick={() => setOpen(null)} className="mt-4 text-sm text-gray-600 hover:text-gray-900">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
