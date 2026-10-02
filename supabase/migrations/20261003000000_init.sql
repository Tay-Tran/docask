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
