"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center shadow-sm">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-gray-600">We hit an unexpected problem loading this page. Please try again.</p>
      <div className="mt-6 flex items-center justify-center gap-4">
        <button type="button" onClick={() => retry()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          Try again
        </button>
        <Link href="/app" className="text-sm text-indigo-700 hover:underline">Back to documents</Link>
      </div>
    </div>
  );
}
