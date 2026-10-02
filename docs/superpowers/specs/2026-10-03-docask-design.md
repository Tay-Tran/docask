# DocAsk – Design Spec

**Date:** 2026-10-03 · **Status:** Approved design, pending implementation plan

## 1. Purpose

DocAsk is a portfolio mini-SaaS: users upload a PDF and ask questions about it. Answers are
grounded only in the document and cite the source passages with page numbers.

It exists to demonstrate, in one live product, the skills most often requested in Upwork jobs:
Next.js + Supabase (Auth, Postgres, **RLS**, Storage, Edge Functions, **pgvector**), retrieval-
augmented generation (**RAG**) with **Claude**, **Stripe** subscriptions with verified webhooks,
server-side authorization, tests, and Vercel deployment.

### Success criteria
- A visitor can sign up with a magic link, upload a PDF, and get a cited answer within a minute.
- One user can never read or modify another user's documents, chunks, questions or plan
  (proven by SQL tests).
- The app stays usable without an Anthropic API key (demo mode) and degrades to demo mode
  if Claude fails.
- Free-plan limits are enforced on the server, not only hidden in the UI.

### Out of scope
Multi-document chat, OCR for scanned PDFs, document sharing, OAuth (Google) login.

## 2. Phases

| Phase | Scope |
|---|---|
| **1** | Schema + RLS, magic-link auth, PDF upload & processing, Q&A (AI + demo mode), UI, tests, deploy |
| **2** | Stripe Pro plan (Checkout, webhook, Customer Portal), billing page, Pro limits |

## 3. Architecture

```
Browser ──upload──▶ Supabase Storage (private bucket "pdfs", path {user_id}/{doc_id}.pdf)
   │
   ├─▶ POST /api/documents/[id]/process  (Next.js route, server)
   │        unpdf → page-aware chunks → Edge Function "embed" (gte-small, 384-d) → chunks table
   │
   └─▶ POST /api/ask  (Next.js route, server, streaming)
            embed question → rpc match_chunks (RLS applies) → Claude (or demo mode) → questions table
```

- **Next.js 16 (App Router), TypeScript, Tailwind CSS 4** on **Vercel**.
- **Supabase** (new project dedicated to DocAsk): Auth, Postgres + pgvector, Storage, one Edge
  Function.
- **Embeddings:** Supabase Edge Function `embed` using the built-in `gte-small` model
  (384 dimensions, free, no extra API key). Requires an authenticated caller.
- **LLM:** Claude Haiku 4.5 via the Anthropic SDK, server-side only. The exact model ID and SDK
  usage are confirmed against current Anthropic docs at implementation time.

## 4. Data model & security

All schema lives in `supabase/migrations/*.sql`.

| Table | Key columns | Notes |
|---|---|---|
| `profiles` | `id` (= `auth.users.id`), `plan` (`free`/`pro`), `stripe_customer_id` | Created by trigger on sign-up |
| `documents` | `id`, `user_id`, `title`, `storage_path`, `size_bytes`, `page_count`, `status` (`processing`/`ready`/`failed`), `error`, `created_at` | |
| `chunks` | `id`, `document_id`, `user_id`, `page`, `content`, `embedding vector(384)` | HNSW index (cosine) on `embedding` |
| `questions` | `id`, `user_id`, `document_id`, `question`, `answer`, `sources jsonb`, `mode` (`ai`/`demo`), `created_at` | History + daily quota counting |
| `stripe_events` *(phase 2)* | `id` (Stripe event ID), `processed_at` | Webhook idempotency |

**RLS (enabled on every table):**
- Users can `select` only rows where `user_id = auth.uid()` (`profiles`: `id = auth.uid()`).
- Users can `insert` their own `documents` only with `status = 'processing'` (`with check`), and
  can `delete` their own rows. There is no client `update` policy: `status`, `page_count` and
  `error` are set only by the server.
- `chunks`, `questions`, `stripe_events`: no client write policies; written by the server
  with the service role.
- `profiles.plan` and `stripe_customer_id` cannot be changed by the user; only the Stripe
  webhook (service role) changes them.

**Storage:** private bucket `pdfs`; policies allow a user to read/write only objects under
`{auth.uid()}/`.

**Search function:** `match_chunks(query_embedding vector(384), p_document_id uuid,
match_count int)` – `security invoker`, so RLS still applies; returns `id, page, content,
similarity` ordered by cosine similarity.

**Secrets:** `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` exist only in server env vars, never in `NEXT_PUBLIC_*`.

## 5. Plans & limits (enforced server-side)

| | Free | Pro *(phase 2)* |
|---|---|---|
| Documents | 3 | 50 |
| Max file size | 5 MB | 20 MB |
| Max pages | 50 | 300 |
| Questions per day (UTC) | 20 | 500 |

Limits live in one module (`lib/plans.ts`) used by both API routes and UI.

## 6. Flows

### Upload & processing
1. Client validates type (`application/pdf`) and size, then uploads directly to Storage.
2. Client inserts the `documents` row (`status = processing`) and calls
   `POST /api/documents/[id]/process`.
3. Server: verifies ownership and plan limits → downloads the file → extracts text per page
   with `unpdf` → splits into ~800-character chunks with ~150-character overlap, never
   crossing a page boundary (each chunk keeps its page number) → embeds in batches via `embed`
   → inserts `chunks` → sets `status = ready` and `page_count`.
4. On failure: `status = failed` with a readable `error` (e.g. "No text found – this may be a
   scanned PDF", "Too many pages for the Free plan"). The UI offers retry/delete.

### Ask
1. `POST /api/ask { documentId, question }` (question ≤ 500 chars).
2. Server: auth → ownership and `status = ready` → daily quota → embed question →
   `match_chunks` (top 5).
3. **AI mode** (API key present): Claude receives the numbered passages and the question with
   instructions to answer only from the passages, cite them as `[n]`, and say when the answer
   is not in the document. The response is streamed to the client.
4. **Demo mode** (no key, or Claude error/timeout): return the top 3 passages as the answer,
   labelled "Demo mode – AI answers are off" (or "AI unavailable, showing matching passages").
5. Store the question, answer, `sources` (chunk IDs, pages, excerpts) and `mode` in `questions`.

### Stripe (phase 2)
- `POST /api/stripe/checkout` creates a Checkout Session (subscription, Pro $9/month, test mode).
- `POST /api/stripe/webhook` verifies the signature (`stripe.webhooks.constructEvent`), skips
  events already in `stripe_events`, and handles `checkout.session.completed` and
  `customer.subscription.updated` / `.deleted` by updating `profiles.plan`.
- `POST /api/stripe/portal` opens the Customer Portal.

## 7. Pages & UI

| Route | Content |
|---|---|
| `/` | Landing: value proposition, 3 features, "Get started" |
| `/login` | Email field → "Send magic link" → "Check your email" |
| `/auth/callback` | Exchanges the code for a session, redirects to `/app` |
| `/app` | Drag-and-drop upload, document list with status badges, retry/delete, usage bar ("2/3 documents · 5/20 questions today") |
| `/app/doc/[id]` | Chat with streamed answers; clickable `[n]` citations open the passage with its page number (side panel on desktop, bottom sheet on mobile); question history; suggested starter questions |
| `/app/billing` *(phase 2)* | Current plan, Upgrade to Pro, Manage subscription |

- All `/app/*` routes are protected on the server; unauthenticated users go to `/login`.
- Tailwind, clean productivity look, indigo accent; mobile-first; explicit loading, error and
  empty states everywhere.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Scanned / image-only PDF | `failed` with explanation |
| Over plan limit (docs, size, pages, questions) | 403 with a specific message; UI shows it with an upgrade hint |
| Claude error, timeout or no credit | Fall back to demo mode for that answer and say so |
| `embed` function error | Processing `failed` (retry possible); ask returns 503 with a friendly message |
| Document not ready | 409 "Still processing" |
| Webhook bad signature | 400, nothing changed |

## 9. Testing

- **Vitest unit tests:** chunking (page boundaries, overlap, empty pages), plan-limit checks,
  prompt building, citation parsing.
- **SQL RLS tests** (run against the local/linked DB): as user A, cannot select B's documents,
  chunks or questions; cannot update own `profiles.plan`; `match_chunks` returns nothing for
  B's document.
- **Manual browser checks:** upload, processing states, AI and demo answers, quota exhaustion,
  invalid files, mobile layout.

## 10. Deployment & docs

- Vercel (Next.js) + Supabase (DB, Storage, Edge Function).
- `.env.example` lists every variable; secrets are entered by the owner, never committed.
- README: architecture diagram, setup steps, RLS explanation, demo GIF, live link.
