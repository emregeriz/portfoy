-- =====================================================================
-- Halka arz son gün hatırlatması (WhatsApp)
-- halkarz.sql ve whatsapp.sql sonrası çalıştır.
--
-- Talep toplamanın son günü, kapanış saatinden belli bir süre önce
-- (varsayılan 2 saat: 17:00 kapanış → 15:00 mesaj) WhatsApp'tan haber
-- verilir. Gönderimi ipo-deadline Edge Function'ı yapar; hangi arzın
-- haber edildiği buradaki damgayla tutulur ki aynı arz ikinci kez
-- yazılmasın.
--
--   deadline_notified_at : hatırlatma gönderildiği (ya da kapanış
--                          kaçırıldığı için sessizce geçildiği) an
-- =====================================================================

alter table public.ipo_feed
  add column if not exists deadline_notified_at timestamptz;

-- Kapanışı geçmiş arzlar damgalanır — yoksa fonksiyonun ilk koşusunda
-- geçmişteki her arz "kaçırıldı" diye tek tek işlenir. Tarih metni
-- sitedeki hâliyle durduğu için burada ayrıştırılmaz; bugünden önceki
-- yılları/ayları kaba bir süzgeçle yakalamak yerine damgayı fonksiyona
-- bırakmak daha güvenli: geçmiş kapanışları sessizce damgalar, mesaj atmaz.

-- Kontrol
--   select slug, date_text, detail->>'tarih', deadline_notified_at
--   from public.ipo_feed where is_draft = false order by sort_order;
--
-- Bir arzı yeniden hatırlatmaya açmak için:
--   update public.ipo_feed set deadline_notified_at = null where slug = '<slug>';
