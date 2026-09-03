-- =====================================================================
-- Kalem bazlı stopaj oranı
--
-- Şimdiye kadar stopaj tür üzerinden çalışıyordu: `kind = 'fon'` olan her
-- şeye %17,5, hisseye 0. Ama hisse senedi yoğun fon (ör. PHE) TEFAS'ta fon
-- olarak durur ve satış kazancından stopaj kesilmez. Bu ayrım tür alanına
-- sığmadığı için kaleme kendi oranı verildi.
--
-- tax_rate:
--   null   → varsayılan (fonda %17,5, hissede 0) — mevcut davranış
--   0      → stopaj yok (hisse senedi yoğun fon)
--   0.175  → %17,5 (oran kesir olarak yazılır, yüzde olarak değil)
--
-- Supabase SQL Editor'de bir kez çalıştır.
-- =====================================================================

alter table public.assets
  add column if not exists tax_rate numeric;

comment on column public.assets.tax_rate is
  'Satış kazancından kesilen stopaj oranı, kesir olarak (0,175 = %17,5). '
  'null ise türün varsayılanı kullanılır: fonda %17,5, hissede 0. '
  'Hisse senedi yoğun fonda 0 yazılır.';
