-- =====================================================================
-- Borç & fatura hatırlatmaları
-- schema.sql sonrası çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Fatura ayrı bir borç türü
alter table public.liabilities drop constraint if exists liabilities_type_check;
alter table public.liabilities add constraint liabilities_type_check
  check (type in ('kredi_karti','kredi','kisisel_borc','fatura','diger'));

-- ---------------------------------------------------------------- 2
-- Aynı borç için günde bir kez mail gitsin
alter table public.liabilities
  add column if not exists last_reminded_on date;

-- ---------------------------------------------------------------- 3
-- Hatırlatmanın gideceği adres; boşsa giriş e-postası kullanılır
alter table public.profiles
  add column if not exists reminder_email text;

-- ---------------------------------------------------------------- 4
-- Aylık tekrarlayan faturalar
--   repeat_monthly : açıksa vadesi geçince bir sonraki ay otomatik açılır
--   series_id      : aynı faturanın aylık kopyalarını birbirine bağlar,
--                    böylece aynı ay iki kez üretilmez
alter table public.liabilities
  add column if not exists repeat_monthly boolean not null default false,
  add column if not exists series_id      uuid;

-- Tekrarlayan kayıtların kendi serisini başlatması için
update public.liabilities set series_id = id
where repeat_monthly and series_id is null;

create index if not exists liabilities_series_idx
  on public.liabilities(series_id, due_date);

-- =====================================================================
-- Serbest hatırlatıcılar — borçtan bağımsız, kendi yazdığın hatırlatmalar
-- title  → mailin konusu
-- body   → mailin içeriği
-- =====================================================================
create table if not exists public.reminders (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  title        text not null,
  body         text,
  next_date    date not null,
  repeat_mode  text not null default 'once' check (repeat_mode in ('once','monthly')),
  is_active    boolean not null default true,
  last_sent_on date,
  created_at   timestamptz not null default now()
);
create index if not exists reminders_due_idx on public.reminders(next_date) where is_active;

alter table public.reminders enable row level security;
drop policy if exists read_all_authenticated on public.reminders;
drop policy if exists insert_own on public.reminders;
drop policy if exists update_own on public.reminders;
drop policy if exists delete_own on public.reminders;
create policy read_all_authenticated on public.reminders
  for select to authenticated using (true);
create policy insert_own on public.reminders
  for insert to authenticated with check (auth.uid() = user_id);
create policy update_own on public.reminders
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.reminders
  for delete to authenticated using (auth.uid() = user_id);

-- =====================================================================
-- Kullanıcı bazlı mail sağlayıcı anahtarları
--
-- Her kullanıcı kendi Resend hesabını kendi adresiyle açar; mail o hesabın
-- anahtarıyla gönderilir, böylece herkes kendi giriş adresine hatırlatma
-- alır (Resend doğrulanmamış hesapta yalnızca kendi adresine izin veriyor).
--
-- RLS açık ama BİLEREK hiçbir politika tanımlı değil: authenticated
-- kullanıcılar bu tabloyu okuyamaz, kimse diğerinin anahtarını göremez.
-- Yalnızca service_role (Edge Function) erişir.
-- =====================================================================
create table if not exists public.user_mail_keys (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  resend_key text not null,
  updated_at timestamptz not null default now()
);

alter table public.user_mail_keys enable row level security;

-- Hatırlatmaya saat de eklenir; cron 15 dakikada bir çalışıp saati gelenleri gönderir
alter table public.reminders
  add column if not exists send_time time not null default '09:00';
