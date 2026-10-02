import Link from "next/link";

const features = [
  { title: "Answers with citations", text: "Every answer points to the exact passage and page it came from." },
  { title: "Private by design", text: "Row Level Security keeps each user's documents and questions isolated." },
  { title: "Fast semantic search", text: "pgvector finds the most relevant passages in milliseconds." },
];

export default function Landing() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-20">
      <p className="text-sm font-semibold text-indigo-700">DocAsk</p>
      <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Chat with your PDFs. Get answers with page citations.</h1>
      <p className="mt-5 max-w-xl text-lg text-gray-600">Upload a contract, manual or report and ask questions in plain language. DocAsk answers only from your document.</p>
      <Link href="/login" className="mt-8 inline-block rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700">Get started &ndash; it&apos;s free</Link>
      <div className="mt-16 grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm text-gray-600">{f.text}</p>
          </div>
        ))}
      </div>
      <p className="mt-16 text-xs text-gray-500">Portfolio project · Next.js · Supabase (Auth, RLS, pgvector, Edge Functions) · Claude</p>
    </main>
  );
}
