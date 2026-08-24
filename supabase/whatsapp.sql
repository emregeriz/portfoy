-- =====================================================================
-- Hatırlatmaların WhatsApp'tan gitmesi (CallMeBot)
-- reminders.sql sonrası çalıştır.
--
-- CallMeBot resmi WhatsApp API'si değil; kişinin kendi numarasına, kendi
-- aldığı apikey ile mesaj atan ücretsiz bir aracı. Kurulum: aşağıdaki
-- numarayı rehbere ekle, WhatsApp'tan "I allow callmebot to send me
-- messages" yaz, dönen apikey'i buraya gir.
--   +34 644 51 95 23   (numara değişebiliyor: callmebot.com/blog)
--
-- Numarası tanımlı olmayan kullanıcı e-posta almaya devam eder; WhatsApp
-- isteği hata verirse hatırlatma kaybolmasın diye yine mail'e düşülür.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Kullanıcı bazlı WhatsApp adresi ve anahtarı
--
-- CallMeBot'ta apikey numaraya bağlıdır, ikisi birlikte durur. Ortak bir
-- varsayılan numara BİLEREK yok: adres kullanıcı bazlı olmazsa herkesin
-- hatırlatması aynı telefona düşerdi.
--
-- RLS açık ama user_mail_keys'te olduğu gibi hiçbir politika tanımlı
-- değil: yalnızca service_role (Edge Function) erişir.
create table if not exists public.user_wa_keys (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  phone      text not null,
  apikey     text not null,
  updated_at timestamptz not null default now()
);

alter table public.user_wa_keys enable row level security;

-- ---------------------------------------------------------------- 2
-- Kendi kaydını gir
--
-- Kullanıcı kimliğini bulmak için:  select id, email from auth.users;
--
-- DİKKAT: bu dosya depoya gidiyor. Yer tutucuları çalıştırmadan önce
-- gerçek değerlerle değiştir, çalıştırdıktan sonra geri koy.
insert into public.user_wa_keys (user_id, phone, apikey)
select id, '<TELEFON>', '<APIKEY>'
from auth.users
where email = '<GIRIS_EPOSTAN>'
on conflict (user_id) do update
  set phone = excluded.phone, apikey = excluded.apikey, updated_at = now();

-- ---------------------------------------------------------------- 3
-- Kontrol
--   select user_id, phone, updated_at from public.user_wa_keys;
--
-- Vazgeçip mail'e dönmek için kaydı silmek yeterli:
--   delete from public.user_wa_keys where phone = '<TELEFON>';
