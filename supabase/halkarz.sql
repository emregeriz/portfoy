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

-- =====================================================================
-- Yeni arz WhatsApp bildirimi
--
-- notified_at: bildirim gönderildiği an damgalanır. Yalnızca TARİHİ BELLİ
-- arzlar bildirilir — taslaklar ve "Hazırlanıyor..." / "Ertelendi"
-- kayıtları damgasız bekler, tarihleri açıklandığı koşuda haber edilir.
--
-- Kolon eklenirken hâlihazırda tarihi belli olan kayıtlar damgalanır;
-- yoksa ilk koşuda geçmişteki bütün arzlar "yeni" sayılıp tek seferde
-- onlarca bildirim gider. Tarihsiz olanlar bilerek null bırakılır.
--
-- Mesaj user_wa_keys'teki her numaraya gider (bkz. whatsapp.sql).
-- =====================================================================
alter table public.ipo_feed
  add column if not exists notified_at timestamptz;

update public.ipo_feed
set notified_at = now()
where notified_at is null
  and is_draft = false
  and date_text ~ '[0-9]'
  -- Ay adlari ASCII'ye dayanikli yazildi: '.' Turkce harfin yerini tutar,
  -- boylece dosya kodlama bozan bir araci gecse de desen calisir.
  and date_text ~* '(ocak|.ubat|mart|nisan|may.s|haziran|temmuz|a.ustos|eyl.l|ekim|kas.m|aral.k)';

-- Kontrol: damgasız kalanlar (bunlar tarihi açıklanınca bildirilecek)
--   select slug, date_text from public.ipo_feed
--   where notified_at is null and is_draft = false;
