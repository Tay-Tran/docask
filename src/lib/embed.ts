import { env } from "./env";

export class EmbedError extends Error {}

// The Edge Function has a ~2 s CPU budget per call: 16 passages hit WORKER_RESOURCE_LIMIT,
// 8 come close, so send small batches and run a few of them in parallel instead.
const BATCH = 4;
const CONCURRENCY = 4;

async function embedBatch(texts: string[], accessToken: string, attempt = 1): Promise<number[][]> {
  const res = await fetch(`${env.supabaseUrl}/functions/v1/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: env.publishableKey },
    body: JSON.stringify({ input: texts }),
  });
  // A 5xx (e.g. 546 WORKER_RESOURCE_LIMIT) is often transient: retry once.
  if (res.status >= 500 && attempt < 2) return embedBatch(texts, accessToken, attempt + 1);
  if (!res.ok) throw new EmbedError(`Embedding failed (${res.status})`);
  const { embeddings } = (await res.json()) as { embeddings: number[][] };
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) throw new EmbedError("Embedding count mismatch");
  return embeddings;
}

export async function embedTexts(texts: string[], accessToken: string): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) batches.push(texts.slice(i, i + BATCH));

  const results: number[][][] = new Array(batches.length);
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const index = next++;
      results[index] = await embedBatch(batches[index], accessToken);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return results.flat();
}
