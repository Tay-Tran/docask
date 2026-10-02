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
  const { data: reserved, error: reserveError } = await admin
    .from("questions")
    .insert({ user_id: auth.user.id, document_id: doc.id, question, answer: "", mode: "demo", sources: [] })
    .select("id")
    .single();
  if (reserveError || !reserved) {
    console.error("[ask] failed to reserve question:", reserveError?.message);
    return NextResponse.json({ error: "Could not record your question. Please try again." }, { status: 503 });
  }
  const rowId = reserved.id;

  const save = async (answer: string, mode: "ai" | "demo", used: Source[]) => {
    try {
      const { error } = await admin
        .from("questions")
        .update({ answer, mode, sources: used.map((s, i) => ({ n: i + 1, chunk_id: s.id, page: s.page, content: s.content })) })
        .eq("id", rowId);
      if (error) console.error("[ask] failed to save answer:", error.message);
    } catch (e) {
      console.error("[ask] failed to save answer:", e instanceof Error ? e.message : "unknown error");
    }
  };

  const encoder = new TextEncoder();
  const header = (mode: "ai" | "demo", used: Source[]) =>
    encoder.encode(JSON.stringify({ mode, sources: used.map((s, i) => ({ n: i + 1, page: s.page, content: s.content })) }) + "\n");

  let claude: ReturnType<Anthropic["messages"]["stream"]> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        if (req.signal.aborted) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // stream already closed or cancelled
        }
      };
      const demo = async (reason: "no_key" | "ai_error") => {
        const used = sources.slice(0, 3);
        const answer = sources.length ? demoAnswer(used, reason) : "I couldn't find anything relevant in this document.";
        safeEnqueue(header("demo", used));
        safeEnqueue(encoder.encode(answer));
        await save(answer, "demo", used);
      };

      let answer = "";
      let saved = false;
      try {
        if (!env.anthropicKey || sources.length === 0) {
          await demo("no_key");
          saved = true;
          return;
        }

        const client = new Anthropic({ apiKey: env.anthropicKey, timeout: 30_000, maxRetries: 0 });
        claude = client.messages.stream(
          {
            model: MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildUserPrompt(question, sources) }],
          },
          { signal: req.signal },
        );
        // The header goes out with the first token, so a failure before any text
        // can still fall back to a demo answer with its own header.
        let headerSent = false;
        try {
          for await (const event of claude) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              if (!headerSent) {
                safeEnqueue(header("ai", sources));
                headerSent = true;
              }
              answer += event.delta.text;
              safeEnqueue(encoder.encode(event.delta.text));
            }
          }
          if (!headerSent) {
            await demo("ai_error");
            saved = true;
            return;
          }
          const final = await claude.finalMessage();
          if (final.stop_reason === "max_tokens") {
            const note = "\n\n(Answer truncated.)";
            answer += note;
            safeEnqueue(encoder.encode(note));
          }
        } catch (error) {
          if (req.signal.aborted) return;
          console.error("[ask] Claude failed:", error instanceof Error ? error.message : "unknown error");
          if (!headerSent) {
            answer = "";
            await demo("ai_error");
            saved = true;
          } else {
            const note = "\n\n(The answer was cut off because the AI service failed.)";
            answer += note;
            safeEnqueue(encoder.encode(note));
          }
        }
      } catch (error) {
        console.error("[ask] unexpected error:", error instanceof Error ? error.message : "unknown error");
      } finally {
        if (!saved && answer) await save(answer, "ai", sources);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      claude?.abort();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
