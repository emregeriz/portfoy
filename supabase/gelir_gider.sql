-- =====================================================================
-- Takip sayfası — gelir/gider kalemleri (ek giderlerden bağımsız)
-- Supabase SQL Editor'de tek seferde çalıştır.
-- =====================================================================

create table if not exists public.gelir_gider (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  entry_date date not null,
  kind       text not null check (kind in ('gelir', 'gider')),
  title      text not null,
  amount     numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists gelir_gider_user_date_idx
  on public.gelir_gider(user_id, entry_date desc);

alter table public.gelir_gider enable row level security;

drop policy if exists read_all_authenticated on public.gelir_gider;
drop policy if exists insert_own on public.gelir_gider;
drop policy if exists update_own on public.gelir_gider;
drop policy if exists delete_own on public.gelir_gider;

create policy read_all_authenticated on public.gelir_gider
  for select to authenticated using (true);
create policy insert_own on public.gelir_gider
  for insert to authenticated with check (auth.uid() = user_id);
create policy update_own on public.gelir_gider
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.gelir_gider
  for delete to authenticated using (auth.uid() = user_id);
