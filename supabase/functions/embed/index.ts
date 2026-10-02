// Supabase Edge Function (Deno). gte-small runs inside Supabase: no external API key.
const session = new Supabase.ai.Session("gte-small");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // The gateway's verify_jwt also lets the (public) publishable key through, so confirm a real user.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
  });
  if (!userRes.ok) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let input: unknown;
  try {
    ({ input } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > 64 || !input.every((t) => typeof t === "string" && t.length <= 2000)) {
    return Response.json({ error: "input must be 1-64 strings of at most 2000 characters" }, { status: 400 });
  }

  const embeddings: number[][] = [];
  for (const text of input as string[]) {
    embeddings.push((await session.run(text, { mean_pool: true, normalize: true })) as number[]);
  }
  return Response.json({ embeddings });
});
