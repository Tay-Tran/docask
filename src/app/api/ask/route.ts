import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { buildUserPrompt, demoAnswer, SYSTEM_PROMPT, type Source } from "@/lib/answer";
import { embedTexts } from "@/lib/embed";
import { env } from "@/lib/env";
import { checkQuestion } from "@/lib/plans";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { countQuestionsToday, getPlan } from "@/lib/usage";

export const maxDuration = 60;
const MODEL = "claude-haiku-4-5";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { documentId?: string; question?: string } | null;
  const question = body?.question?.trim() ?? "";
  if (!body?.documentId || !question || question.length > 500) {
    return NextResponse.json({ error: "Ask a question of 1-500 characters." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const { data: session } = await supabase.auth.getSession();
  if (!auth.user || !session.session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data: doc } = await supabase.from("documents").select("id, status").eq("id", body.documentId).single();
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  if (doc.status !== "ready") return NextResponse.json({ error: "Still processing" }, { status: 409 });

  let quota: ReturnType<typeof checkQuestion>;
  try {
    quota = checkQuestion(await getPlan(supabase, auth.user.id), await countQuestionsToday(supabase));
  } catch {
    return NextResponse.json({ error: "Could not check your usage. Please try again." }, { status: 503 });
  }
  if (!quota.ok) return NextResponse.json({ error: quota.reason }, { status: 403 });

  let sources: Source[];
  try {
    const [embedding] = await embedTexts([question], session.session.access_token);
    const { data, error } = await supabase.rpc("match_chunks", { query_embedding: JSON.stringify(embedding), p_document_id: doc.id, match_count: 5 });
    if (error) throw error;
    sources = (data ?? []).map((r: { id: number; page: number; content: string }) => ({ id: r.id, page: r.page, content: r.content }));
  } catch {
    return NextResponse.json({ error: "Search is temporarily unavailable. Please try again." }, { status: 503 });
  }

  const admin = createAdminClient();
  const save = (answer: string, mode: "ai" | "demo", used: Source[]) =>
    admin.from("questions").insert({ user_id: auth.user.id, document_id: doc.id, question, answer, mode, sources: used.map((s, i) => ({ n: i + 1, chunk_id: s.id, page: s.page, content: s.content })) });

  const encoder = new TextEncoder();
  const header = (mode: "ai" | "demo", used: Source[]) =>
    encoder.encode(JSON.stringify({ mode, sources: used.map((s, i) => ({ n: i + 1, page: s.page, content: s.content })) }) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const demo = async (reason: "no_key" | "ai_error") => {
        const used = sources.slice(0, 3);
        const answer = sources.length ? demoAnswer(used, reason) : "I couldn't find anything relevant in this document.";
        controller.enqueue(header("demo", used));
        controller.enqueue(encoder.encode(answer));
        await save(answer, "demo", used);
      };

      if (!env.anthropicKey || sources.length === 0) {
        await demo("no_key");
        return controller.close();
      }

      let answer = "";
      try {
        const client = new Anthropic({ apiKey: env.anthropicKey, timeout: 30_000, maxRetries: 1 });
        const claude = client.messages.stream({
          model: MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(question, sources) }],
        });
        // The header goes out with the first token, so a failure before any text
        // can still fall back to a demo answer with its own header.
        let headerSent = false;
        for await (const event of claude) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            if (!headerSent) {
              controller.enqueue(header("ai", sources));
              headerSent = true;
            }
            answer += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        await save(answer, "ai", sources);
      } catch (error) {
        console.error("[ask] Claude failed, falling back to demo mode:", error instanceof Error ? error.message : error);
        if (answer === "") {
          await demo("ai_error");
        } else {
          controller.enqueue(encoder.encode("\n\n(The answer was cut off because the AI service failed.)"));
          await save(answer, "ai", sources);
        }
      }
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
