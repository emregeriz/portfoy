-- =====================================================================
-- Takip sayfası — dönemsel varlık kayıtları
-- Supabase SQL Editor'de tek seferde çalıştır.
-- =====================================================================

create table if not exists public.takip_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  entry_date date not null,
  items      jsonb not null default '{}'::jsonb,
  debt       numeric not null default 0,
  expenses   jsonb not null default '[]'::jsonb,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists takip_entries_user_date_idx
  on public.takip_entries(user_id, entry_date desc);

-- Mevcut kurulumlar için: ek gider kolonu
alter table public.takip_entries
  add column if not exists expenses jsonb not null default '[]'::jsonb;

alter table public.takip_entries enable row level security;

drop policy if exists read_all_authenticated on public.takip_entries;
drop policy if exists insert_own on public.takip_entries;
drop policy if exists update_own on public.takip_entries;
drop policy if exists delete_own on public.takip_entries;

create policy read_all_authenticated on public.takip_entries
  for select to authenticated using (true);
create policy insert_own on public.takip_entries
  for insert to authenticated with check (auth.uid() = user_id);
create policy update_own on public.takip_entries
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.takip_entries
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- Kalem listesi kullanıcı bazlı
-- Her kullanıcı kendi varlık kalemlerini tanımlar; yeni kayıt açarken
-- kendi listesi gelir. Ortak/sabit liste yok.
-- =====================================================================
create table if not exists public.takip_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists takip_items_user_idx on public.takip_items(user_id, sort_order);

alter table public.takip_items enable row level security;
drop policy if exists read_all_authenticated on public.takip_items;
drop policy if exists insert_own on public.takip_items;
drop policy if exists update_own on public.takip_items;
drop policy if exists delete_own on public.takip_items;
create policy read_all_authenticated on public.takip_items
  for select to authenticated using (true);
create policy insert_own on public.takip_items
  for insert to authenticated with check (auth.uid() = user_id);
create policy update_own on public.takip_items
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.takip_items
  for delete to authenticated using (auth.uid() = user_id);

-- Mevcut kayıtlarda kullanılan kalemleri sahibine aktar (bir kez)
insert into public.takip_items (user_id, name, sort_order)
select e.user_id, k.kalem, min(k.sira)
from public.takip_entries e
cross join lateral (
  select key as kalem, ord as sira
  from jsonb_each(e.items) with ordinality as t(key, val, ord)
) k
group by e.user_id, k.kalem
on conflict (user_id, name) do nothing;
