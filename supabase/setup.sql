-- ═══════════════════════════════════════════════════════════════
-- Petale — Supabase 전체 세팅 스크립트
-- 새 프로젝트를 만든 뒤 SQL Editor에 통째로 붙여넣고 실행하세요.
-- (여러 번 실행해도 안전하도록 idempotent 하게 작성)
-- ═══════════════════════════════════════════════════════════════

-- 검색용 트라이그램 확장 (public 오염을 피해 extensions 스키마에 설치)
create schema if not exists extensions;
create extension if not exists pg_trgm schema extensions;

-- ── 프로필 ───────────────────────────────────────────────────
create table if not exists public.petale_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique
    check (char_length(username) >= 3 and char_length(username) <= 20
           and username ~ '^[a-zA-Z0-9_]+$'),
  created_at timestamptz not null default now()
);
alter table public.petale_profiles enable row level security;

drop policy if exists "profiles readable" on public.petale_profiles;
create policy "profiles readable" on public.petale_profiles
  for select using (true); -- 사용자명으로 친구 검색

drop policy if exists "profiles insert self" on public.petale_profiles;
create policy "profiles insert self" on public.petale_profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles update self" on public.petale_profiles;
create policy "profiles update self" on public.petale_profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ── 친구 관계 ────────────────────────────────────────────────
create table if not exists public.petale_friendships (
  id bigint generated always as identity primary key,
  requester uuid not null references public.petale_profiles(id) on delete cascade,
  addressee uuid not null references public.petale_profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  unique (requester, addressee)
);
alter table public.petale_friendships enable row level security;

drop policy if exists "friendship visible to parties" on public.petale_friendships;
create policy "friendship visible to parties" on public.petale_friendships
  for select using (auth.uid() = requester or auth.uid() = addressee);

drop policy if exists "friendship request self" on public.petale_friendships;
create policy "friendship request self" on public.petale_friendships
  for insert with check (auth.uid() = requester);

drop policy if exists "friendship respond" on public.petale_friendships;
create policy "friendship respond" on public.petale_friendships
  for update using (auth.uid() = requester or auth.uid() = addressee)
  with check (auth.uid() = requester or auth.uid() = addressee);

drop policy if exists "friendship remove" on public.petale_friendships;
create policy "friendship remove" on public.petale_friendships
  for delete using (auth.uid() = requester or auth.uid() = addressee);

-- ── 일일 학습 기록 (친구 대시보드) ──────────────────────────
create table if not exists public.petale_daily_stats (
  user_id uuid not null references public.petale_profiles(id) on delete cascade,
  day date not null,
  reviews integer not null default 0 check (reviews >= 0),
  streak integer not null default 0 check (streak >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.petale_daily_stats enable row level security;

-- 리뷰 수/스트릭은 민감정보가 아니므로 로그인 사용자에게 공개(친구 기록 열람)
drop policy if exists "stats readable to authed" on public.petale_daily_stats;
create policy "stats readable to authed" on public.petale_daily_stats
  for select to authenticated using (true);

drop policy if exists "stats upsert self" on public.petale_daily_stats;
create policy "stats upsert self" on public.petale_daily_stats
  for insert with check (auth.uid() = user_id);

drop policy if exists "stats update self" on public.petale_daily_stats;
create policy "stats update self" on public.petale_daily_stats
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 공개 덱 (탐색/공유) ─────────────────────────────────────
create table if not exists public.petale_shared_decks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.petale_profiles(id) on delete cascade,
  name text not null check (char_length(name) >= 1 and char_length(name) <= 60),
  description text not null default '' check (char_length(description) <= 200),
  card_count integer not null default 0 check (card_count >= 1 and card_count <= 2000),
  payload jsonb not null check (pg_column_size(payload) < 1200000),
  downloads integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, name)
);
alter table public.petale_shared_decks enable row level security;

create index if not exists petale_shared_decks_name_trgm
  on public.petale_shared_decks using gin (name extensions.gin_trgm_ops);

-- 누구나(비로그인 포함) 열람 가능, 쓰기는 소유자만
drop policy if exists "shared decks public read" on public.petale_shared_decks;
create policy "shared decks public read" on public.petale_shared_decks
  for select using (true);

drop policy if exists "shared decks owner insert" on public.petale_shared_decks;
create policy "shared decks owner insert" on public.petale_shared_decks
  for insert with check (auth.uid() = owner);

drop policy if exists "shared decks owner update" on public.petale_shared_decks;
create policy "shared decks owner update" on public.petale_shared_decks
  for update using (auth.uid() = owner) with check (auth.uid() = owner);

drop policy if exists "shared decks owner delete" on public.petale_shared_decks;
create policy "shared decks owner delete" on public.petale_shared_decks
  for delete using (auth.uid() = owner);

-- 다운로드 카운터 (비로그인도 셀 수 있게 security definer, search_path 고정)
create or replace function public.petale_bump_downloads(p_deck uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.petale_shared_decks set downloads = downloads + 1 where id = p_deck;
$$;

-- ── 계정별 컬렉션 (덱·카드 전체 클라우드 동기화) ───────────────
create table if not exists public.petale_collections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
    check (pg_column_size(data) < 8000000), -- ~8MB
  updated_at timestamptz not null default now()
);
alter table public.petale_collections enable row level security;

drop policy if exists "collection own select" on public.petale_collections;
create policy "collection own select" on public.petale_collections
  for select using (auth.uid() = user_id);

drop policy if exists "collection own insert" on public.petale_collections;
create policy "collection own insert" on public.petale_collections
  for insert with check (auth.uid() = user_id);

drop policy if exists "collection own update" on public.petale_collections;
create policy "collection own update" on public.petale_collections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "collection own delete" on public.petale_collections;
create policy "collection own delete" on public.petale_collections
  for delete using (auth.uid() = user_id);

-- ── 이미지 저장소 (기기 간 동기화 · 공유 덱 이미지) ─────────────
-- 이미지는 컬렉션 JSON이 아니라 Storage 버킷에 개별 파일로 보관한다.
-- 경로 규칙: {auth.uid()}/{mediaId}
insert into storage.buckets (id, name, public)
values ('petale-media', 'petale-media', true)
on conflict (id) do nothing;

-- 읽기: 공개 (내 다른 기기 · 공유 덱 이미지 열람). 경로가 UUID라 열거는 사실상 불가.
drop policy if exists "petale media read" on storage.objects;
create policy "petale media read" on storage.objects
  for select using (bucket_id = 'petale-media');

-- 쓰기/수정/삭제: 로그인 사용자가 '자기 폴더'에만
drop policy if exists "petale media insert" on storage.objects;
create policy "petale media insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'petale-media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "petale media update" on storage.objects;
create policy "petale media update" on storage.objects
  for update to authenticated
  using (bucket_id = 'petale-media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "petale media delete" on storage.objects;
create policy "petale media delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'petale-media' and (storage.foldername(name))[1] = auth.uid()::text);
