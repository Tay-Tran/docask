# DocAsk Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployed DocAsk where a user signs in by magic link, uploads a PDF, and gets answers grounded in it with page citations (Claude when a key is set, demo mode otherwise), with RLS isolating every user's data.

**Architecture:** Next.js 16 App Router on Vercel. Supabase provides Auth (magic link), Postgres + pgvector, a private Storage bucket and one Edge Function (`embed`, gte-small 384-d). Route handlers do PDF processing (`unpdf` → page-aware chunks → `embed` → `chunks`) and Q&A (`embed` question → `match_chunks` RPC → Claude stream or demo passages).

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, `@supabase/supabase-js`, `@supabase/ssr`, `unpdf`, `@anthropic-ai/sdk`, Vitest, Supabase CLI (via `npx supabase`).

**Spec:** `docs/superpowers/specs/2026-10-03-docask-design.md`

## Global Constraints

- Next.js 16: route protection lives in `src/proxy.ts` (the `middleware` file convention is renamed to `proxy`). Read `node_modules/next/dist/docs/` before using an unfamiliar Next API.
- Claude model ID: `claude-haiku-4-5` (exact string, no date suffix). SDK: `@anthropic-ai/sdk`, server-side only.
- Embedding dimension: `384` everywhere (`vector(384)`).
- Free plan limits: 3 documents, 5 MB, 50 pages, 20 questions/day (UTC). Pro (phase 2): 50 docs, 20 MB, 300 pages, 500 questions/day.
- Chunking: ~800 characters, ~150-character overlap, never crossing a page boundary.
- Retrieval: top 5 chunks for AI mode; demo mode shows top 3.
- Question length ≤ 500 characters.
- Secrets (`SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`) are never `NEXT_PUBLIC_*` and never committed.
- UI accent: Tailwind `indigo`. Every data view has loading, error and empty states.
- Commit after each task; messages end with the `Co-Authored-By` line used in this repo.
- Deviation from spec §9 (documented here): RLS is tested with a Vitest integration suite that signs in two real test users through `supabase-js` against the linked project, because the local Supabase stack (Docker) is not available on this machine.

## File Structure

```
docask/
  .env.example
  proxy-free root files: package.json, next.config.ts, vitest.config.ts, tsconfig.json
  supabase/
    config.toml                         (created by `supabase init`)
    migrations/20261003000000_init.sql  schema, RLS, storage, match_chunks, profile trigger
    functions/embed/index.ts            gte-small embeddings (Deno)
  src/
    proxy.ts                            refresh session, guard /app/*
    lib/
      plans.ts            plan limits + checks (pure)
      chunking.ts         page-aware chunker (pure)
      answer.ts           prompt builder, citation parser, demo answer (pure)
      env.ts              typed env access
      supabase/server.ts  server client (cookies) + admin client
      supabase/browser.ts browser client
      embed.ts            calls the `embed` Edge Function
      usage.ts            reads document count + today's question count
    app/
      page.tsx                       landing
      login/page.tsx, login/LoginForm.tsx
      auth/callback/route.ts
      app/layout.tsx                 app shell + usage bar
      app/page.tsx                   document list + upload
      app/UploadBox.tsx, app/DocumentList.tsx
      app/doc/[id]/page.tsx          chat page (server)
      app/doc/[id]/Chat.tsx          chat UI (client)
      api/documents/[id]/process/route.ts
      api/ask/route.ts
  tests/
    plans.test.ts, chunking.test.ts, answer.test.ts
    rls.integration.test.ts
```

---

### Task 1: Scaffold the project

**Files:** Create the Next.js app, `.env.example`, `vitest.config.ts`; modify `package.json`, `.gitignore`.

**Interfaces:** Produces the `@/*` import alias (→ `src/*`) and the `npm test` script used by every later task.

- [ ] **Step 1: Create the app inside the existing repo folder**

The `docask` folder already holds `docs/`. Scaffold in a temp folder and move the files in:

```bash
cd "C:/Project khach/BG"
npx --yes create-next-app@latest docask-tmp --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --no-turbopack --yes
cd docask-tmp && rm -rf .git && cp -r . ../docask/ && cd .. && rm -rf docask-tmp
```

- [ ] **Step 2: Install dependencies**

```bash
cd "C:/Project khach/BG/docask"
npm install @supabase/supabase-js @supabase/ssr unpdf @anthropic-ai/sdk
npm install -D vitest
```

- [ ] **Step 3: Add Vitest config and scripts**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

In `package.json` `scripts`, add:
```json
"test": "vitest run --exclude tests/**/*.integration.test.ts",
"test:rls": "vitest run tests/rls.integration.test.ts"
```

- [ ] **Step 4: Add `.env.example` and allow it in git**

```bash
# Supabase (Project Settings → API). Publishable key is safe in the browser.
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
# Secret key: server only, bypasses RLS. Never expose or commit.
SUPABASE_SECRET_KEY=
# Optional. Without it DocAsk runs in demo mode (shows matching passages).
ANTHROPIC_API_KEY=
```

In `.gitignore`, after the `.env*` line add `!.env.example`.

- [ ] **Step 5: Verify and commit**

Run: `npm run build` → Expected: build succeeds.
```bash
git add -A && git commit -m "Scaffold Next.js app with Supabase, unpdf, Anthropic SDK and Vitest"
```

---

### Task 2: Plan limits module

**Files:** Create `src/lib/plans.ts`; Test `tests/plans.test.ts`.

**Interfaces:**
- Produces: `type Plan = "free" | "pro"`; `PLAN_LIMITS: Record<Plan, PlanLimits>`; `type PlanLimits = { maxDocuments: number; maxFileBytes: number; maxPages: number; questionsPerDay: number }`; `checkUpload(plan, { documentCount, fileBytes }): LimitResult`; `checkPages(plan, pages): LimitResult`; `checkQuestion(plan, questionsToday): LimitResult`; `type LimitResult = { ok: true } | { ok: false; reason: string }`.

- [ ] **Step 1: Write the failing test**

`tests/plans.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, checkPages, checkQuestion, checkUpload } from "@/lib/plans";

describe("plans", () => {
  it("free limits match the spec", () => {
    expect(PLAN_LIMITS.free).toEqual({ maxDocuments: 3, maxFileBytes: 5 * 1024 * 1024, maxPages: 50, questionsPerDay: 20 });
  });

  it("blocks a 4th free document", () => {
    const r = checkUpload("free", { documentCount: 3, fileBytes: 1000 });
    expect(r).toEqual({ ok: false, reason: "The Free plan allows up to 3 documents. Delete one to upload another." });
  });

  it("blocks files over the size limit", () => {
    const r = checkUpload("free", { documentCount: 0, fileBytes: 5 * 1024 * 1024 + 1 });
    expect(r.ok).toBe(false);
  });

  it("allows a valid upload", () => {
    expect(checkUpload("free", { documentCount: 2, fileBytes: 1024 })).toEqual({ ok: true });
  });

  it("blocks too many pages and too many questions", () => {
    expect(checkPages("free", 51).ok).toBe(false);
    expect(checkPages("free", 50).ok).toBe(true);
    expect(checkQuestion("free", 20)).toEqual({ ok: false, reason: "You've used all 20 questions for today. Try again tomorrow." });
    expect(checkQuestion("pro", 20)).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- plans` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/plans.ts`:
```ts
export type Plan = "free" | "pro";
export type PlanLimits = { maxDocuments: number; maxFileBytes: number; maxPages: number; questionsPerDay: number };
export type LimitResult = { ok: true } | { ok: false; reason: string };

const MB = 1024 * 1024;

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxDocuments: 3, maxFileBytes: 5 * MB, maxPages: 50, questionsPerDay: 20 },
  pro: { maxDocuments: 50, maxFileBytes: 20 * MB, maxPages: 300, questionsPerDay: 500 },
};

const planName = (plan: Plan) => (plan === "free" ? "Free" : "Pro");

export function checkUpload(plan: Plan, input: { documentCount: number; fileBytes: number }): LimitResult {
  const limits = PLAN_LIMITS[plan];
  if (input.documentCount >= limits.maxDocuments) {
    return { ok: false, reason: `The ${planName(plan)} plan allows up to ${limits.maxDocuments} documents. Delete one to upload another.` };
  }
  if (input.fileBytes > limits.maxFileBytes) {
    return { ok: false, reason: `Files on the ${planName(plan)} plan can be up to ${limits.maxFileBytes / MB} MB.` };
  }
  return { ok: true };
}

export function checkPages(plan: Plan, pages: number): LimitResult {
  const max = PLAN_LIMITS[plan].maxPages;
  return pages > max ? { ok: false, reason: `This PDF has ${pages} pages; the ${planName(plan)} plan allows up to ${max}.` } : { ok: true };
}

export function checkQuestion(plan: Plan, questionsToday: number): LimitResult {
  const max = PLAN_LIMITS[plan].questionsPerDay;
  return questionsToday >= max ? { ok: false, reason: `You've used all ${max} questions for today. Try again tomorrow.` } : { ok: true };
}
```

- [ ] **Step 4: Run tests** — `npm test -- plans` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add plan limits module"`

---

### Task 3: Page-aware chunker

**Files:** Create `src/lib/chunking.ts`; Test `tests/chunking.test.ts`.

**Interfaces:**
- Produces: `type Chunk = { page: number; content: string }`; `chunkPages(pages: string[], opts?: { size?: number; overlap?: number }): Chunk[]` — `pages[i]` is the text of page `i + 1`; defaults `size = 800`, `overlap = 150`.

- [ ] **Step 1: Write the failing test**

`tests/chunking.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { chunkPages } from "@/lib/chunking";

describe("chunkPages", () => {
  it("keeps short pages as one chunk each with 1-based page numbers", () => {
    expect(chunkPages(["Hello world.", "Second page."])).toEqual([
      { page: 1, content: "Hello world." },
      { page: 2, content: "Second page." },
    ]);
  });

  it("skips empty and whitespace-only pages and collapses whitespace", () => {
    expect(chunkPages(["  ", "a\n\n  b"])).toEqual([{ page: 2, content: "a b" }]);
  });

  it("splits long pages with overlap and never exceeds size", () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkPages([text], { size: 200, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.page).toBe(1);
      expect(c.content.length).toBeLessThanOrEqual(200);
    }
    // consecutive chunks share text (overlap)
    const tail = chunks[0].content.slice(-30);
    expect(chunks[1].content).toContain(tail.split(" ").slice(-1)[0]);
    // nothing lost: last word appears in the last chunk
    expect(chunks.at(-1)!.content).toContain("word299");
  });

  it("does not cut words in half", () => {
    const chunks = chunkPages(["alpha beta gamma delta epsilon zeta eta theta"], { size: 20, overlap: 5 });
    for (const c of chunks) {
      for (const w of c.content.split(" ")) {
        expect(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]).toContain(w);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- chunking` → FAIL.

- [ ] **Step 3: Implement**

`src/lib/chunking.ts`:
```ts
export type Chunk = { page: number; content: string };

/**
 * Splits each page into chunks of at most `size` characters on word boundaries,
 * overlapping consecutive chunks by about `overlap` characters. Chunks never span pages,
 * so every chunk can be cited with a single page number.
 */
export function chunkPages(pages: string[], opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? 800;
  const overlap = opts.overlap ?? 150;
  const chunks: Chunk[] = [];

  pages.forEach((raw, index) => {
    const words = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    let start = 0;

    while (start < words.length) {
      let end = start;
      let length = 0;
      while (end < words.length && length + words[end].length + (end > start ? 1 : 0) <= size) {
        length += words[end].length + (end > start ? 1 : 0);
        end++;
      }
      if (end === start) end = start + 1; // a single word longer than `size`

      chunks.push({ page: index + 1, content: words.slice(start, end).join(" ").slice(0, size) });
      if (end >= words.length) break;

      // Step back so the next chunk starts ~`overlap` characters before this one ended.
      let back = end;
      let backLength = 0;
      while (back > start + 1 && backLength + words[back - 1].length + 1 <= overlap) {
        back--;
        backLength += words[back].length + 1;
      }
      start = back;
    }
  });

  return chunks;
}
```

- [ ] **Step 4: Run tests** — `npm test -- chunking` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add page-aware chunker"`

---

### Task 4: Answer helpers (prompt, citations, demo answer)

**Files:** Create `src/lib/answer.ts`; Test `tests/answer.test.ts`.

**Interfaces:**
- Produces: `type Source = { id: number; page: number; content: string }` (`id` = chunk id); `SYSTEM_PROMPT: string`; `buildUserPrompt(question: string, sources: Source[]): string` (passages numbered `[1]..[n]`); `citedNumbers(answer: string): number[]` (unique, ascending, only valid indices are kept by caller); `demoAnswer(sources: Source[], reason: "no_key" | "ai_error"): string`.

- [ ] **Step 1: Write the failing test**

`tests/answer.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildUserPrompt, citedNumbers, demoAnswer, SYSTEM_PROMPT } from "@/lib/answer";

const sources = [
  { id: 11, page: 2, content: "Refunds are issued within 14 days." },
  { id: 12, page: 5, content: "Contact support by email." },
];

describe("answer helpers", () => {
  it("numbers passages and includes the question", () => {
    const p = buildUserPrompt("How long do refunds take?", sources);
    expect(p).toContain('<passage index="1" page="2">\nRefunds are issued within 14 days.\n</passage>');
    expect(p).toContain('<passage index="2" page="5">');
    expect(p).toContain("<question>\nHow long do refunds take?\n</question>");
  });

  it("system prompt requires grounding and [n] citations", () => {
    expect(SYSTEM_PROMPT).toMatch(/only/i);
    expect(SYSTEM_PROMPT).toContain("[1]");
  });

  it("extracts unique cited numbers in order", () => {
    expect(citedNumbers("Within 14 days [1]. Email us [2][1].")).toEqual([1, 2]);
    expect(citedNumbers("No citations here.")).toEqual([]);
  });

  it("builds a demo answer from passages with page numbers", () => {
    const a = demoAnswer(sources, "no_key");
    expect(a).toContain("Demo mode");
    expect(a).toContain("[1] (page 2) Refunds are issued within 14 days.");
    expect(demoAnswer(sources, "ai_error")).toContain("AI is unavailable");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- answer` → FAIL.

- [ ] **Step 3: Implement**

`src/lib/answer.ts`:
```ts
export type Source = { id: number; page: number; content: string };

export const SYSTEM_PROMPT = `You answer questions about a document using only the numbered passages provided.
Cite every claim with the passage number in square brackets, like [1] or [2][3].
If the passages do not contain the answer, say "I couldn't find that in this document." and do not guess.
Answer in the language of the question. Keep answers concise: a short paragraph or a few bullet points.`;

export function buildUserPrompt(question: string, sources: Source[]): string {
  const passages = sources
    .map((s, i) => `<passage index="${i + 1}" page="${s.page}">\n${s.content}\n</passage>`)
    .join("\n");
  return `<passages>\n${passages}\n</passages>\n\n<question>\n${question}\n</question>`;
}

export function citedNumbers(answer: string): number[] {
  const found = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}

export function demoAnswer(sources: Source[], reason: "no_key" | "ai_error"): string {
  const header =
    reason === "no_key"
      ? "Demo mode – AI answers are off. Here are the most relevant passages:"
      : "AI is unavailable right now. Here are the most relevant passages:";
  const lines = sources.map((s, i) => `[${i + 1}] (page ${s.page}) ${s.content}`);
  return [header, ...lines].join("\n\n");
}
```

- [ ] **Step 4: Run tests** — `npm test` → all PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add prompt, citation and demo answer helpers"`

---

### Task 5: Database schema, RLS and storage

**Files:** Create `supabase/config.toml` (via CLI), `supabase/migrations/20261003000000_init.sql`.

**Interfaces:**
- Produces tables `profiles`, `documents`, `chunks`, `questions`; bucket `pdfs`; function `match_chunks(query_embedding vector(384), p_document_id uuid, match_count int) returns table(id bigint, page int, content text, similarity float)`.

**Prerequisite (owner action):** a new Supabase project "DocAsk" exists; the owner ran `npx supabase login` and gave the project ref. Auth → URL configuration has Site URL `http://localhost:3005` (later the Vercel URL) and redirect URL `http://localhost:3005/auth/callback`.

- [ ] **Step 1: Init and link**

```bash
npx supabase init
npx supabase link --project-ref <PROJECT_REF>
```

- [ ] **Step 2: Write the migration**

`supabase/migrations/20261003000000_init.sql`:
```sql
create extension if not exists vector with schema extensions;

-- profiles -------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  stripe_customer_id text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: read own" on public.profiles for select to authenticated using (id = (select auth.uid()));

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- documents ------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  storage_path text not null,
  size_bytes bigint not null check (size_bytes > 0),
  page_count int,
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index documents_user_idx on public.documents (user_id, created_at desc);
alter table public.documents enable row level security;
create policy "documents: read own" on public.documents for select to authenticated using (user_id = (select auth.uid()));
create policy "documents: insert own as processing" on public.documents for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'processing' and page_count is null and error is null
              and storage_path like (select auth.uid())::text || '/%');
create policy "documents: delete own" on public.documents for delete to authenticated using (user_id = (select auth.uid()));
-- no update policy: status/page_count/error are written by the server only

-- chunks ---------------------------------------------------------------
create table public.chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  page int not null,
  content text not null,
  embedding extensions.vector(384) not null
);
create index chunks_document_idx on public.chunks (document_id);
create index chunks_embedding_idx on public.chunks using hnsw (embedding extensions.vector_cosine_ops);
alter table public.chunks enable row level security;
create policy "chunks: read own" on public.chunks for select to authenticated using (user_id = (select auth.uid()));

-- questions ------------------------------------------------------------
create table public.questions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  question text not null,
  answer text not null,
  sources jsonb not null default '[]',
  mode text not null check (mode in ('ai', 'demo')),
  created_at timestamptz not null default now()
);
create index questions_user_day_idx on public.questions (user_id, created_at);
create index questions_document_idx on public.questions (document_id, created_at);
alter table public.questions enable row level security;
create policy "questions: read own" on public.questions for select to authenticated using (user_id = (select auth.uid()));

-- search (security invoker => RLS on chunks applies) --------------------
create function public.match_chunks(query_embedding extensions.vector(384), p_document_id uuid, match_count int default 5)
returns table (id bigint, page int, content text, similarity float)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.page, c.content, 1 - (c.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.chunks c
  where c.document_id = p_document_id
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(match_count, 20);
$$;

-- storage --------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 20971520, array['application/pdf']);

create policy "pdfs: read own" on storage.objects for select to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "pdfs: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "pdfs: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.uid())::text);
```

- [ ] **Step 3: Apply and verify**

Run: `npx supabase db push` → Expected: migration applied without errors.
Run: `npx supabase db lint` → Expected: no errors.

- [ ] **Step 4: Commit** — `git add supabase && git commit -m "Add schema, RLS policies, storage bucket and match_chunks"`

---

### Task 6: `embed` Edge Function and client

**Files:** Create `supabase/functions/embed/index.ts`, `src/lib/embed.ts`, `src/lib/env.ts`.

**Interfaces:**
- Edge Function: `POST /functions/v1/embed` body `{ input: string[] }` (1–64 items, each ≤ 2000 chars) → `{ embeddings: number[][] }`; requires a valid user JWT (`verify_jwt` default on).
- Produces: `embedTexts(texts: string[], accessToken: string): Promise<number[][]>` (batches of 32, throws `EmbedError` on failure); `class EmbedError extends Error`; `env` object `{ supabaseUrl, publishableKey, secretKey, anthropicKey }` where `secretKey`/`anthropicKey` are read lazily.

- [ ] **Step 1: Write the function**

`supabase/functions/embed/index.ts`:
```ts
// Supabase Edge Function (Deno). gte-small runs inside Supabase: no external API key.
const session = new Supabase.ai.Session("gte-small");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

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
```

- [ ] **Step 2: Deploy and smoke-test**

```bash
npx supabase functions deploy embed
```
Smoke test (needs a signed-in user's access token; do it after Task 7 from the browser console with `supabase.functions.invoke("embed", { body: { input: ["hello"] } })`): Expected `embeddings[0].length === 384`.

- [ ] **Step 3: Env helper**

`src/lib/env.ts`:
```ts
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  publishableKey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  get secretKey() {
    return required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY);
  },
  get anthropicKey(): string | null {
    return process.env.ANTHROPIC_API_KEY || null;
  },
};
```

- [ ] **Step 4: Embed client**

`src/lib/embed.ts`:
```ts
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
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → no errors (the Deno function is outside `src`; if tsc picks it up, add `"exclude": ["supabase"]` to `tsconfig.json`).
```bash
git add -A && git commit -m "Add gte-small embed Edge Function and client"
```

---

### Task 7: Supabase clients, auth and route protection

**Files:** Create `src/lib/supabase/server.ts`, `src/lib/supabase/browser.ts`, `src/proxy.ts`, `src/app/login/page.tsx`, `src/app/login/LoginForm.tsx`, `src/app/auth/callback/route.ts`.

**Interfaces:**
- Produces: `createClient(): Promise<SupabaseClient>` (server, cookie session, RLS applies); `createAdminClient(): SupabaseClient` (secret key, bypasses RLS – server only); `createBrowserSupabase(): SupabaseClient`; `requireUser(): Promise<{ supabase, user }>` (redirects to `/login`).

- [ ] **Step 1: Server and browser clients**

`src/lib/supabase/server.ts`:
```ts
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** Bypasses RLS. Only for writes the user must not be able to make directly. */
export function createAdminClient() {
  return createSupabaseClient(env.supabaseUrl, env.secretKey, { auth: { persistSession: false } });
}

export async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return { supabase, user: data.user };
}
```

Install the guard package: `npm install server-only`.

`src/lib/supabase/browser.ts`:
```ts
import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
```

- [ ] **Step 2: Proxy (session refresh + /app guard)**

`src/proxy.ts`:
```ts
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  if (!data.user && request.nextUrl.pathname.startsWith("/app")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/app/:path*", "/api/:path*", "/login"],
};
```

- [ ] **Step 3: Login page**

`src/app/login/LoginForm.tsx`:
```tsx
"use client";

import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const { error } = await createBrowserSupabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setError(error.message);
      setState("error");
    } else {
      setState("sent");
    }
  }

  if (state === "sent") {
    return (
      <p className="rounded-lg bg-indigo-50 p-4 text-sm text-indigo-900">
        Check <strong>{email}</strong> for a sign-in link. You can close this tab.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block text-sm font-medium" htmlFor="email">Email</label>
      <input
        id="email" type="email" required autoComplete="email" value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
      />
      {state === "error" && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <button
        type="submit" disabled={state === "sending"}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
      >
        {state === "sending" ? "Sending…" : "Send magic link"}
      </button>
    </form>
  );
}
```

`src/app/login/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const { data } = await (await createClient()).auth.getUser();
  if (data.user) redirect("/app");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="text-2xl font-semibold">Sign in to DocAsk</h1>
      <p className="mb-6 mt-2 text-sm text-gray-600">We'll email you a one-time sign-in link. No password needed.</p>
      <LoginForm />
    </main>
  );
}
```

- [ ] **Step 4: Auth callback**

`src/app/auth/callback/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/app", request.url));
  }
  return NextResponse.redirect(new URL("/login?error=link", request.url));
}
```

- [ ] **Step 5: Verify manually and commit**

Fill `.env.local` (owner pastes keys). `npm run dev -- -p 3005`, open `/app` → redirected to `/login`; request a link, click it → lands on `/app` (404 until Task 9 is fine).
```bash
git add -A && git commit -m "Add Supabase clients, magic-link login and /app protection"
```

---

### Task 8: Document processing route

**Files:** Create `src/lib/usage.ts`, `src/app/api/documents/[id]/process/route.ts`.

**Interfaces:**
- Consumes: `requireUser`/`createClient`, `createAdminClient` (Task 7); `embedTexts`, `EmbedError` (Task 6); `chunkPages` (Task 3); `checkUpload`, `checkPages`, `type Plan` (Task 2).
- Produces: `getPlan(supabase, userId): Promise<Plan>`; `countDocuments(supabase): Promise<number>`; `countQuestionsToday(supabase): Promise<number>`; `POST /api/documents/{id}/process` → `200 { status: "ready", pageCount }` | `4xx/5xx { error }` (document marked `failed` with that message).

- [ ] **Step 1: Usage helpers**

`src/lib/usage.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Plan } from "./plans";

export async function getPlan(supabase: SupabaseClient, userId: string): Promise<Plan> {
  const { data } = await supabase.from("profiles").select("plan").eq("id", userId).single();
  return (data?.plan as Plan) ?? "free";
}

export async function countDocuments(supabase: SupabaseClient): Promise<number> {
  const { count } = await supabase.from("documents").select("id", { count: "exact", head: true });
  return count ?? 0;
}

export async function countQuestionsToday(supabase: SupabaseClient): Promise<number> {
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("questions")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startOfDayUtc.toISOString());
  return count ?? 0;
}
```

- [ ] **Step 2: Process route**

`src/app/api/documents/[id]/process/route.ts`:
```ts
import { NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkPages } from "@/lib/chunking";
import { embedTexts, EmbedError } from "@/lib/embed";
import { checkPages, checkUpload } from "@/lib/plans";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { countDocuments, getPlan } from "@/lib/usage";

export const maxDuration = 60;

export async function POST(_req: Request, ctx: RouteContext<"/api/documents/[id]/process">) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const { data: session } = await supabase.auth.getSession();
  if (!auth.user || !session.session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // RLS: returns the row only if the caller owns it.
  const { data: doc } = await supabase.from("documents").select("id, storage_path, size_bytes, status").eq("id", id).single();
  if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const admin = createAdminClient();
  const fail = async (status: number, message: string) => {
    await admin.from("documents").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status });
  };
  if (doc.status === "failed") await admin.from("documents").update({ status: "processing", error: null }).eq("id", id);

  const plan = await getPlan(supabase, auth.user.id);
  // The new row is already counted, so compare against count - 1.
  const uploadCheck = checkUpload(plan, { documentCount: (await countDocuments(supabase)) - 1, fileBytes: doc.size_bytes });
  if (!uploadCheck.ok) return fail(403, uploadCheck.reason);

  const { data: file, error: downloadError } = await supabase.storage.from("pdfs").download(doc.storage_path);
  if (downloadError || !file) return fail(400, "Could not read the uploaded file. Please upload it again.");

  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    pages = (await extractText(pdf, { mergePages: false })).text;
  } catch {
    return fail(400, "This file could not be read as a PDF.");
  }

  const pageCheck = checkPages(plan, pages.length);
  if (!pageCheck.ok) return fail(403, pageCheck.reason);

  const chunks = chunkPages(pages);
  if (chunks.length === 0) return fail(400, "No text found – this may be a scanned PDF. Scanned documents are not supported.");

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(chunks.map((c) => c.content), session.session.access_token);
  } catch (error) {
    return fail(502, error instanceof EmbedError ? "Indexing service failed. Please retry." : "Unexpected error while indexing.");
  }

  await admin.from("chunks").delete().eq("document_id", id); // safe re-run on retry
  const rows = chunks.map((c, i) => ({ document_id: id, user_id: auth.user.id, page: c.page, content: c.content, embedding: JSON.stringify(embeddings[i]) }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from("chunks").insert(rows.slice(i, i + 200));
    if (error) return fail(500, "Could not save the document index. Please retry.");
  }

  await admin.from("documents").update({ status: "ready", page_count: pages.length, error: null }).eq("id", id);
  return NextResponse.json({ status: "ready", pageCount: pages.length });
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit && npm run lint` → clean. Manual check happens in Task 9.
```bash
git add -A && git commit -m "Add PDF processing route with plan checks and indexing"
```

---

### Task 9: Documents page (upload + list)

**Files:** Create `src/app/app/layout.tsx`, `src/app/app/page.tsx`, `src/app/app/UploadBox.tsx`, `src/app/app/DocumentList.tsx`, `src/app/app/actions.ts`.

**Interfaces:**
- Consumes: `requireUser`, `getPlan`, `countDocuments`, `countQuestionsToday`, `PLAN_LIMITS`, `createBrowserSupabase`.
- Produces: `type DocumentRow = { id: string; title: string; status: "processing" | "ready" | "failed"; error: string | null; page_count: number | null; created_at: string }`; server action `deleteDocument(id: string)`.

- [ ] **Step 1: App shell with usage bar**

`src/app/app/layout.tsx`:
```tsx
import Link from "next/link";
import { PLAN_LIMITS } from "@/lib/plans";
import { requireUser } from "@/lib/supabase/server";
import { countDocuments, countQuestionsToday, getPlan } from "@/lib/usage";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const { supabase, user } = await requireUser();
  const [plan, docs, questions] = await Promise.all([getPlan(supabase, user.id), countDocuments(supabase), countQuestionsToday(supabase)]);
  const limits = PLAN_LIMITS[plan];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link href="/app" className="font-semibold text-indigo-700">DocAsk</Link>
          <p className="text-xs text-gray-600">
            {docs}/{limits.maxDocuments} documents · {questions}/{limits.questionsPerDay} questions today ·{" "}
            <span className="font-medium uppercase">{plan}</span>
          </p>
          <form action="/auth/signout" method="post">
            <button className="text-sm text-gray-600 hover:text-gray-900">Sign out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
```

Add sign-out route `src/app/auth/signout/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  await (await createClient()).auth.signOut();
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
```

- [ ] **Step 2: Delete action**

`src/app/app/actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/supabase/server";

export async function deleteDocument(id: string) {
  const { supabase } = await requireUser();
  const { data: doc } = await supabase.from("documents").select("storage_path").eq("id", id).single();
  if (!doc) return;
  await supabase.storage.from("pdfs").remove([doc.storage_path]);
  await supabase.from("documents").delete().eq("id", id); // RLS: own rows only; chunks/questions cascade
  revalidatePath("/app");
}
```

- [ ] **Step 3: Upload box**

`src/app/app/UploadBox.tsx`:
```tsx
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

export function UploadBox({ userId, maxBytes, disabledReason }: { userId: string; maxBytes: number; disabledReason?: string }) {
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
      if (insErr) throw new Error(insErr.message);
      router.refresh();
      const res = await fetch(`/api/documents/${id}/process`, { method: "POST" });
      if (!res.ok) setError((await res.json()).error ?? "Processing failed.");
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
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !disabledReason) upload(f); }}
      className="rounded-xl border-2 border-dashed border-indigo-200 bg-white p-8 text-center"
    >
      <p className="font-medium">{busy ? "Uploading and indexing…" : "Drop a PDF here"}</p>
      <p className="mt-1 text-sm text-gray-500">Max {maxBytes / 1024 / 1024} MB · text-based PDFs only</p>
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
```

- [ ] **Step 4: Document list**

`src/app/app/DocumentList.tsx`:
```tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
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

  // Poll while anything is processing.
  useEffect(() => {
    if (!documents.some((d) => d.status === "processing")) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [documents, router]);

  if (documents.length === 0) {
    return <p className="rounded-xl bg-white p-6 text-center text-sm text-gray-500">No documents yet. Upload a PDF to start asking questions.</p>;
  }

  return (
    <ul className="divide-y rounded-xl bg-white shadow-sm">
      {documents.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            {d.status === "ready" ? (
              <Link href={`/app/doc/${d.id}`} className="font-medium text-indigo-700 hover:underline">{d.title}</Link>
            ) : (
              <span className="font-medium">{d.title}</span>
            )}
            <p className="text-xs text-gray-500">
              {d.page_count ? `${d.page_count} pages · ` : ""}{new Date(d.created_at).toLocaleDateString()}
            </p>
            {d.status === "failed" && d.error && <p className="mt-1 text-sm text-red-600">{d.error}</p>}
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge[d.status]}`}>{d.status}</span>
          {d.status === "failed" && (
            <button
              onClick={() => fetch(`/api/documents/${d.id}/process`, { method: "POST" }).then(() => router.refresh())}
              className="text-sm text-indigo-700 hover:underline"
            >
              Retry
            </button>
          )}
          <button
            disabled={pending}
            onClick={() => confirm(`Delete "${d.title}"?`) && startTransition(() => deleteDocument(d.id))}
            className="text-sm text-gray-500 hover:text-red-600"
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Page**

`src/app/app/page.tsx`:
```tsx
import { checkUpload } from "@/lib/plans";
import { PLAN_LIMITS } from "@/lib/plans";
import { requireUser } from "@/lib/supabase/server";
import { getPlan } from "@/lib/usage";
import { DocumentList, type DocumentRow } from "./DocumentList";
import { UploadBox } from "./UploadBox";

export default async function DocumentsPage() {
  const { supabase, user } = await requireUser();
  const plan = await getPlan(supabase, user.id);
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, status, error, page_count, created_at")
    .order("created_at", { ascending: false });
  const documents = (data ?? []) as DocumentRow[];
  const limit = checkUpload(plan, { documentCount: documents.length, fileBytes: 1 });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Your documents</h1>
      <UploadBox userId={user.id} maxBytes={PLAN_LIMITS[plan].maxFileBytes} disabledReason={limit.ok ? undefined : limit.reason} />
      {error ? <p className="text-sm text-red-600">Could not load documents. Refresh to try again.</p> : <DocumentList documents={documents} />}
    </div>
  );
}
```

- [ ] **Step 6: Verify manually and commit**

`npm run dev -- -p 3005`: sign in → upload a small text PDF → badge goes processing → ready; upload an image-only PDF → failed with the scanned-PDF message; delete works.
```bash
git add -A && git commit -m "Add documents page with upload, status polling and delete"
```

---

### Task 10: Ask route (AI + demo, streaming)

**Files:** Create `src/app/api/ask/route.ts`.

**Interfaces:**
- Consumes: `createClient`, `createAdminClient`, `embedTexts`, `checkQuestion`, `getPlan`, `countQuestionsToday`, `SYSTEM_PROMPT`, `buildUserPrompt`, `demoAnswer`, `type Source`, `env.anthropicKey`.
- Produces: `POST /api/ask { documentId: string, question: string }` → `200` `text/plain` stream. **Wire format:** first line is JSON `{"mode":"ai"|"demo","sources":[{"n":1,"page":2,"content":"..."}]}` followed by `\n`, then the answer text (streamed). Errors return JSON `{ error }` with 400/401/403/404/409/503.

- [ ] **Step 1: Implement**

`src/app/api/ask/route.ts`:
```ts
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

  const quota = checkQuestion(await getPlan(supabase, auth.user.id), await countQuestionsToday(supabase));
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
```

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit && npm run lint` → clean.
Manual: with no `ANTHROPIC_API_KEY`, `fetch('/api/ask', {method:'POST', body: JSON.stringify({documentId, question:'...'})})` from the browser console returns a first line with `"mode":"demo"`.
```bash
git add -A && git commit -m "Add ask route with Claude streaming and demo fallback"
```

---

### Task 11: Chat page

**Files:** Create `src/app/app/doc/[id]/page.tsx`, `src/app/app/doc/[id]/Chat.tsx`.

**Interfaces:**
- Consumes: `/api/ask` wire format (Task 10); `questions` rows (`question, answer, sources, mode, created_at`).
- Produces: none for later tasks.

- [ ] **Step 1: Server page**

`src/app/app/doc/[id]/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/supabase/server";
import { Chat, type Turn } from "./Chat";

export default async function DocPage(props: PageProps<"/app/doc/[id]">) {
  const { id } = await props.params;
  const { supabase } = await requireUser();
  const { data: doc } = await supabase.from("documents").select("id, title, status, page_count").eq("id", id).single();
  if (!doc || doc.status !== "ready") notFound();

  const { data: history } = await supabase
    .from("questions")
    .select("question, answer, sources, mode")
    .eq("document_id", id)
    .order("created_at", { ascending: true })
    .limit(50);

  return (
    <div className="space-y-4">
      <Link href="/app" className="text-sm text-indigo-700 hover:underline">← All documents</Link>
      <h1 className="text-2xl font-semibold">{doc.title}</h1>
      <p className="text-sm text-gray-500">{doc.page_count} pages</p>
      <Chat documentId={doc.id} initial={(history ?? []) as Turn[]} />
    </div>
  );
}
```

- [ ] **Step 2: Client chat**

`src/app/app/doc/[id]/Chat.tsx`:
```tsx
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
```

- [ ] **Step 3: Verify manually and commit**

Ask a question on a ready document → answer appears (demo mode without a key), citation chips open the passage with its page, history persists on reload, the 21st question of the day shows the quota message.
```bash
git add -A && git commit -m "Add chat page with streamed answers and clickable citations"
```

---

### Task 12: Landing page and metadata

**Files:** Modify `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`.

- [ ] **Step 1: Root layout metadata**

In `src/app/layout.tsx` set:
```ts
export const metadata: Metadata = {
  title: "DocAsk – Chat with your PDFs",
  description: "Upload a PDF and get answers with page citations.",
};
```
and remove the dark-mode block from `globals.css` so the app stays light (body `background: #f9fafb; color: #111827;`).

- [ ] **Step 2: Landing page**

`src/app/page.tsx`:
```tsx
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
      <Link href="/login" className="mt-8 inline-block rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-700">Get started – it's free</Link>
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
```

- [ ] **Step 3: Verify and commit** — `npm run build` → success.
```bash
git add -A && git commit -m "Add landing page"
```

---

### Task 13: RLS integration tests

**Files:** Create `tests/rls.integration.test.ts`.

**Interfaces:** Consumes the deployed schema (Task 5) and env vars from `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`).

- [ ] **Step 1: Write the tests**

`tests/rls.integration.test.ts`:
```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnvConfig } from "@next/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd());
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

const password = `Test-${crypto.randomUUID()}`;
const users: { id: string; client: SupabaseClient }[] = [];
let docB = "";

async function makeUser(tag: string) {
  const email = `rls-${tag}-${Date.now()}@docask.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  return { id: data.user.id, client };
}

beforeAll(async () => {
  users.push(await makeUser("a"), await makeUser("b"));
  const b = users[1];
  docB = crypto.randomUUID();
  await admin.from("documents").insert({ id: docB, user_id: b.id, title: "B secret", storage_path: `${b.id}/${docB}.pdf`, size_bytes: 10, status: "ready" });
  await admin.from("chunks").insert({ document_id: docB, user_id: b.id, page: 1, content: "B secret text", embedding: JSON.stringify(Array(384).fill(0.01)) });
  await admin.from("questions").insert({ user_id: b.id, document_id: docB, question: "q", answer: "a", mode: "demo" });
});

afterAll(async () => {
  for (const u of users) await admin.auth.admin.deleteUser(u.id); // cascades to rows
});

describe("RLS isolation", () => {
  it("A cannot read B's documents, chunks or questions", async () => {
    const a = users[0].client;
    expect((await a.from("documents").select("id").eq("id", docB)).data).toEqual([]);
    expect((await a.from("chunks").select("id").eq("document_id", docB)).data).toEqual([]);
    expect((await a.from("questions").select("id").eq("document_id", docB)).data).toEqual([]);
  });

  it("match_chunks returns nothing for B's document when called by A", async () => {
    const { data } = await users[0].client.rpc("match_chunks", { query_embedding: JSON.stringify(Array(384).fill(0.01)), p_document_id: docB, match_count: 5 });
    expect(data).toEqual([]);
  });

  it("B can read own chunks through match_chunks", async () => {
    const { data } = await users[1].client.rpc("match_chunks", { query_embedding: JSON.stringify(Array(384).fill(0.01)), p_document_id: docB, match_count: 5 });
    expect(data?.length).toBe(1);
  });

  it("a user cannot upgrade their own plan", async () => {
    const a = users[0];
    await a.client.from("profiles").update({ plan: "pro" }).eq("id", a.id);
    const { data } = await admin.from("profiles").select("plan").eq("id", a.id).single();
    expect(data?.plan).toBe("free");
  });

  it("a user cannot insert a document as ready or for someone else", async () => {
    const a = users[0];
    const asReady = await a.client.from("documents").insert({ title: "x", storage_path: `${a.id}/x.pdf`, size_bytes: 1, status: "ready" });
    expect(asReady.error).not.toBeNull();
    const forB = await a.client.from("documents").insert({ user_id: users[1].id, title: "x", storage_path: `${users[1].id}/x.pdf`, size_bytes: 1 });
    expect(forB.error).not.toBeNull();
  });

  it("a user cannot write chunks or questions directly", async () => {
    const a = users[0];
    expect((await a.client.from("questions").insert({ user_id: a.id, document_id: docB, question: "q", answer: "a", mode: "ai" })).error).not.toBeNull();
    expect((await a.client.from("chunks").insert({ document_id: docB, user_id: a.id, page: 1, content: "x", embedding: JSON.stringify(Array(384).fill(0)) })).error).not.toBeNull();
  });
});
```

Requires Auth → Providers → Email with password sign-in enabled (default) so test users can sign in; the app UI itself only uses magic links.

- [ ] **Step 2: Run** — `npm run test:rls` → all PASS. If any fails, fix the policy in a new migration (never edit an applied one), `npx supabase db push`, re-run.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "Add RLS integration tests"`

---

### Task 14: README, deploy and final verification

**Files:** Modify `README.md`.

- [ ] **Step 1: README**

Replace `README.md` with: title + one-line pitch + live link placeholder filled after deploy; architecture diagram (the block from spec §3); features list; "How security works" (RLS table summary, security-invoker `match_chunks`, server-only secrets); local setup (`npm install`, `.env.local` from `.env.example`, `npx supabase link`, `npx supabase db push`, `npx supabase functions deploy embed`, `npm run dev`); tests (`npm test`, `npm run test:rls`); demo mode explanation; deploy steps (Vercel env vars; Supabase Auth Site URL and redirect `https://<domain>/auth/callback`).

- [ ] **Step 2: Full verification**

Run: `npm test && npm run test:rls && npm run lint && npm run build` → all pass.
Manual on `localhost:3005`: login, upload, process, ask (demo), citations, quota message, delete, mobile width (no horizontal scroll).

- [ ] **Step 3: Commit and publish**

```bash
git add -A && git commit -m "Add README"
```
Owner confirms creating the public GitHub repo, then: `gh repo create Tay-Tran/docask --public --source=. --remote=origin --push`. Owner imports it in Vercel with the env vars and adds the Vercel URL to Supabase Auth URL configuration.
