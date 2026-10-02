import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Next.js skips .env.local when NODE_ENV=test (vitest), so load it explicitly.
process.loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const admin = createClient(url, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

const password = `Test-${crypto.randomUUID()}`;
const users: { id: string; client: SupabaseClient }[] = [];
const storagePaths: string[] = [];
const embedding = JSON.stringify(Array(384).fill(0.01));
let docB = "";
let pathB = "";

function expectRls(error: { code?: string; message?: string } | null) {
  expect(error).not.toBeNull();
  expect(error!.code).toBe("42501");
}

async function makeUser(tag: string) {
  const email = `rls-${tag}-${Date.now()}@docask.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push({ id: data.user.id, client: null as unknown as SupabaseClient }); // registered for cleanup immediately
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);
  users[users.length - 1].client = client;
}

beforeAll(async () => {
  await makeUser("a");
  await makeUser("b");
  const b = users[1];
  docB = crypto.randomUUID();
  pathB = `${b.id}/${docB}.pdf`;
  const must = (r: { error: unknown }) => {
    if (r.error) throw r.error;
  };
  must(await admin.from("documents").insert({ id: docB, user_id: b.id, title: "B secret", storage_path: pathB, size_bytes: 10, status: "ready" }));
  must(await admin.from("chunks").insert({ document_id: docB, user_id: b.id, page: 1, content: "B secret text", embedding }));
  must(await admin.from("questions").insert({ user_id: b.id, document_id: docB, question: "q", answer: "a", mode: "demo" }));
});

afterAll(async () => {
  try {
    if (storagePaths.length) await admin.storage.from("pdfs").remove(storagePaths);
  } catch {}
  for (const u of users) {
    try {
      await admin.auth.admin.deleteUser(u.id); // cascades to rows
    } catch {}
  }
});

describe("RLS isolation", () => {
  it("A cannot read B's documents, chunks or questions", async () => {
    const a = users[0].client;
    expect((await a.from("documents").select("id").eq("id", docB)).data).toEqual([]);
    expect((await a.from("chunks").select("id").eq("document_id", docB)).data).toEqual([]);
    expect((await a.from("questions").select("id").eq("document_id", docB)).data).toEqual([]);
  });

  it("match_chunks returns nothing for B's document when called by A", async () => {
    const { data } = await users[0].client.rpc("match_chunks", { query_embedding: embedding, p_document_id: docB, match_count: 5 });
    expect(data).toEqual([]);
  });

  it("B can read own chunks through match_chunks", async () => {
    const { data } = await users[1].client.rpc("match_chunks", { query_embedding: embedding, p_document_id: docB, match_count: 5 });
    expect(data?.length).toBe(1);
  });

  it("anon cannot call match_chunks or read documents", async () => {
    const anon = createClient(url, publishable, { auth: { persistSession: false } });
    const rpc = await anon.rpc("match_chunks", { query_embedding: embedding, p_document_id: docB, match_count: 5 });
    expect(rpc.error).not.toBeNull(); // execute revoked from anon
    const docs = await anon.from("documents").select("id").eq("id", docB);
    expect(docs.error !== null || (docs.data ?? []).length === 0).toBe(true);
  });

  it("a user cannot upgrade their own plan", async () => {
    const a = users[0];
    await a.client.from("profiles").update({ plan: "pro" }).eq("id", a.id);
    const { data } = await admin.from("profiles").select("plan").eq("id", a.id).single();
    expect(data?.plan).toBe("free");
  });

  it("a user cannot insert a document as ready or for someone else", async () => {
    const a = users[0];
    const asReady = await a.client.from("documents").insert({ title: "x", storage_path: `${a.id}/${crypto.randomUUID()}.pdf`, size_bytes: 1, status: "ready" });
    expectRls(asReady.error);
    const forB = await a.client.from("documents").insert({ user_id: users[1].id, title: "x", storage_path: `${users[1].id}/${crypto.randomUUID()}.pdf`, size_bytes: 1 });
    expectRls(forB.error);
  });

  it("a user cannot insert a document whose storage_path escapes their folder", async () => {
    const a = users[0];
    const b = users[1];
    const r = await a.client.from("documents").insert({ title: "x", storage_path: `${a.id}/../${b.id}/x.pdf`, size_bytes: 1 });
    expectRls(r.error);
    const own = await a.client.from("documents").insert({ title: "x", storage_path: `${a.id}/${crypto.randomUUID()}.pdf`, size_bytes: 1 });
    expect(own.error).toBeNull(); // sanity: the well-formed path is accepted
  });

  it("a user cannot write chunks or questions directly", async () => {
    const a = users[0];
    // Cross-owner targets (rejected by FK or policy) ...
    expect((await a.client.from("questions").insert({ user_id: a.id, document_id: docB, question: "q", answer: "a", mode: "ai" })).error).not.toBeNull();
    expect((await a.client.from("chunks").insert({ document_id: docB, user_id: a.id, page: 1, content: "x", embedding: JSON.stringify(Array(384).fill(0)) })).error).not.toBeNull();
    // ... and same-owner targets, which only the missing insert policy can reject.
    const docA = crypto.randomUUID();
    const d = await admin.from("documents").insert({ id: docA, user_id: a.id, title: "A own", storage_path: `${a.id}/${docA}.pdf`, size_bytes: 5, status: "ready" });
    expect(d.error).toBeNull();
    expectRls((await a.client.from("chunks").insert({ document_id: docA, user_id: a.id, page: 1, content: "x", embedding: JSON.stringify(Array(384).fill(0)) })).error);
    expectRls((await a.client.from("questions").insert({ user_id: a.id, document_id: docA, question: "q", answer: "a", mode: "ai" })).error);
  });

  it("deleting a document keeps its questions (document_id becomes null)", async () => {
    const a = users[0];
    const docId = crypto.randomUUID();
    const ins = await admin.from("documents").insert({ id: docId, user_id: a.id, title: "A doc", storage_path: `${a.id}/${docId}.pdf`, size_bytes: 5, status: "ready" });
    expect(ins.error).toBeNull();
    const q = await admin.from("questions").insert({ user_id: a.id, document_id: docId, question: "keep me", answer: "a", mode: "ai" }).select("id").single();
    expect(q.error).toBeNull();
    const del = await a.client.from("documents").delete().eq("id", docId);
    expect(del.error).toBeNull();
    expect((await admin.from("documents").select("id").eq("id", docId)).data).toEqual([]);
    const { data } = await admin.from("questions").select("id, document_id").eq("id", q.data!.id);
    expect(data).toEqual([{ id: q.data!.id, document_id: null }]);
  });

  it("A cannot read B's PDF object in storage", async () => {
    const up = await admin.storage.from("pdfs").upload(pathB, new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" }), { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    storagePaths.push(pathB);
    const a = users[0].client;
    const dl = await a.storage.from("pdfs").download(pathB);
    expect(dl.error).not.toBeNull();
    expect(dl.data).toBeNull();
    const ls = await a.storage.from("pdfs").list(users[1].id);
    expect(ls.data ?? []).toEqual([]);
    // sanity: B can see own object
    const own = await users[1].client.storage.from("pdfs").list(users[1].id);
    expect(own.data?.length).toBe(1);
  });
});
