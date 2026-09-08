-- =====================================================================
-- Hedefler — "şu tarihe kadar şu kadar varlığım olsun"
-- schema.sql sonrası bir kez çalıştır.
--
-- Bir hedef iki şeyi tutar:
--   1. Varış noktası: tutar + tarih + neyin ölçüleceği (metric)
--   2. Plan (isteğe bağlı): başlangıç tutarı, aylık ekleme, aylık getiri —
--      Hedef sayfasındaki hesaplayıcıdan kaydedilince dolar. Planlı hedefte
--      "bu ay olması gereken" çizgisi çizilir, gerçek değerle kıyaslanır.
--
-- metric:
--   net      → Dashboard'daki net değer (varlık − borç)
--   varlik   → toplam varlık
--   nakit    → hesaplardaki nakit (arz hesapları + bloke dahil)
--   pozisyon → fon/hisse pozisyon değeri
--   manuel   → kullanıcı ilerlemeyi kendisi yazar (manual_value)
-- =====================================================================

create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  target_amount numeric not null check (target_amount > 0),
  target_date   date not null,
  metric        text not null default 'net'
                check (metric in ('net','varlik','nakit','pozisyon','manuel')),
  manual_value  numeric,
  -- plan (hesaplayıcıdan)
  start_amount  numeric not null default 0,
  start_date    date not null default current_date,
  monthly_add   numeric not null default 0,
  /** aylık getiri, yüzde (2 = %2/ay) */
  monthly_rate  numeric not null default 0,
  /** aylık eklemenin yıllık artışı, yüzde (maaş zammı) */
  add_raise     numeric not null default 0,
  note          text,
  is_done       boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists goals_user_idx on public.goals(user_id, target_date);

alter table public.goals enable row level security;
drop policy if exists read_all_authenticated on public.goals;
drop policy if exists insert_own on public.goals;
drop policy if exists update_own on public.goals;
drop policy if exists delete_own on public.goals;
create policy read_all_authenticated on public.goals
  for select to authenticated using (true);
create policy insert_own on public.goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy update_own on public.goals
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.goals
  for delete to authenticated using (auth.uid() = user_id);

-- Kontrol
--   select title, target_amount, target_date, metric, is_done from public.goals;
