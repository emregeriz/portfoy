-- =====================================================================
-- halkarz.com arz takvimi önbelleği
--
-- fetch-halkarz Edge Function'ı siteyi tarayıp buraya yazar; uygulama
-- yalnızca bu tabloyu okur. Böylece sayfa hızlı açılır ve siteye
-- kullanıcı başına istek gitmez.
--
-- Kurulum: bu dosyayı SQL Editor'de çalıştır, sonra Edge Function'ı
-- deploy et (supabase functions deploy fetch-halkarz) ve cron.sql'in
-- sonundaki zamanlamayı aç.
-- =====================================================================

create table if not exists public.ipo_feed (
  slug              text primary key,          -- halkarz.com/[slug]/
  name              text not null,
  bist_code         text,
  /** yeni | gong | ertelendi — listede görünen rozet */
  badge             text,
  /** true = "Taslak Arzlar" sekmesindeki hazırlık aşaması kayıtları */
  is_draft          boolean not null default false,
  /** "12-13-14 Ağustos 2026" ya da "Hazırlanıyor..." — sitedeki ham metin */
  date_text         text,
  price_text        text,
  url               text not null,
  image_url         text,
  /** Sitedeki sıra — liste aynı düzende gösterilsin */
  sort_order        int not null default 0,
  /** Detay sayfasından ayrıştırılan alanlar (tarih, fiyat, dağıtım, sonuçlar…) */
  detail            jsonb,
  detail_fetched_at timestamptz,
  updated_at        timestamptz not null default now()
);

alter table public.ipo_feed enable row level security;

drop policy if exists read_all_authenticated on public.ipo_feed;
create policy read_all_authenticated on public.ipo_feed
  for select to authenticated using (true);
-- Yazma politikası bilerek yok: yalnızca service_role (Edge Function) yazar.
