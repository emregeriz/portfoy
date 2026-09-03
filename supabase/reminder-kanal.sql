-- =====================================================================
-- Hatırlatıcıda kanal seçimi — WhatsApp / e-posta / ikisi birden
-- reminders.sql ve whatsapp.sql sonrası çalıştır.
--
-- Önceden kanal kullanıcıya bağlıydı: numarası olan WhatsApp, olmayan
-- e-posta alıyordu, hatırlatma başına seçim yoktu. Artık her hatırlatma
-- kendi kanalını taşıyor:
--   wa    → yalnızca WhatsApp (gitmezse hatırlatma kaybolmasın diye mail'e düşülür)
--   mail  → yalnızca e-posta
--   both  → ikisi birden; biri gitmese diğeri ulaşır
--
-- Varsayılan 'wa': mevcut kayıtlar bugünkü davranışlarını korusun.
-- =====================================================================

alter table public.reminders
  add column if not exists channel text not null default 'wa';

alter table public.reminders drop constraint if exists reminders_channel_check;
alter table public.reminders add constraint reminders_channel_check
  check (channel in ('wa', 'mail', 'both'));

-- Kontrol
--   select title, next_date, send_time, channel, is_active from public.reminders;
