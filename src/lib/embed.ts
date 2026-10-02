import { env } from "./env";

export class EmbedError extends Error {}

const BATCH = 32;

export async function embedTexts(texts: string[], accessToken: string): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await fetch(`${env.supabaseUrl}/functions/v1/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: env.publishableKey },
      body: JSON.stringify({ input: texts.slice(i, i + BATCH) }),
    });
    if (!res.ok) throw new EmbedError(`Embedding failed (${res.status})`);
    const { embeddings } = (await res.json()) as { embeddings: number[][] };
    out.push(...embeddings);
  }
  return out;
}
