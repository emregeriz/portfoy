-- =====================================================================
-- Halka arz — talep karşılığı (bloke edilen para)
--
-- Sorun: defter arzın yalnızca dönüş tarafını tutuyordu. Dağıtımda geri
-- yatan tutar "iade" olarak (+) yazılıyor, ama talebi verirken hesaptan
-- bloke edilen para hiçbir yere yazılmıyordu. Sonuç: hesapta zaten duran
-- parayla arza girdiğinde iade, yoktan var olmuş yeni para gibi görünüyor
-- ve bakiye şişiyordu.
--
-- Çözüm: talep anında hesaptan çıkan tutar "talep" türüyle (−) yazılır.
--
--     talep (−)  istenen lot × lot fiyatı     ← talep verilince
--     iade  (+)  (istenen − düşen) × fiyat    ← dağıtım açıklanınca
--     ────────────────────────────────────
--     kalan (−)  düşen lot × lot fiyatı  = elindeki payın maliyeti
--
-- "cikis"ten farkı: cikis para sistemden tamamen çıktı demektir ve net
-- varlığı azaltır. "talep" ise para hâlâ senin — sadece dağıtım açıklanana
-- kadar aracı kurumda bloke. Uygulama bu tutarı net varlığa geri ekler.
--
-- borsa-ek.sql sonrası bir kez çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Yeni hareket türü: talep
alter table public.account_ledger
  drop constraint if exists account_ledger_kind_check;
alter table public.account_ledger
  add constraint account_ledger_kind_check
  check (kind in ('giris','iade','satis','transfer','cikis','cekim','nema',
                  'borc','tahsil','alim','temettu','talep','diger'));

-- ---------------------------------------------------------------- 2
-- Bir arzın bir hesaba yalnızca tek talep satırı olur. Uygulama talebi
-- yeniden hesaplarken önce siler sonra yazar; bu indeks iki sekmeden
-- aynı anda kaydetmenin çift bloke yazmasını engeller.
create unique index if not exists account_ledger_talep_uniq
  on public.account_ledger(ipo_id, account_id)
  where kind = 'talep';

-- ---------------------------------------------------------------- 3
-- Arz bazlı para akışı — hangi arzda ne kadar bloke, ne kadar döndü.
--   blocked > 0  → dağıtım henüz açıklanmadı, para aracı kurumda bekliyor
--   blocked = 0  → talep tamamen iade edildi (hiç lot düşmedi)
create or replace view public.v_ipo_cash
with (security_invoker = on) as
select l.user_id,
       l.ipo_id,
       sum(-l.amount) filter (where l.kind = 'talep') as requested,
       sum(l.amount)  filter (where l.kind = 'iade')  as refunded,
       sum(l.amount)  filter (where l.kind = 'satis') as proceeds,
       -sum(l.amount) filter (where l.kind in ('talep','iade')) as blocked
from public.account_ledger l
where l.ipo_id is not null
group by l.user_id, l.ipo_id;
