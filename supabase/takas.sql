-- =====================================================================
-- Takas / valör — satış parası hesaba ne zaman geçer
-- trades.sql ve schema.sql sonrası bir kez çalıştır.
--
-- Hisse satışının parası T+2 iş günü sonra hesaba geçer (pazartesi
-- satış → çarşamba). Fonlar valörlüdür: emri 13:00'ten önce verirsen
-- valör gün, sonra verirsen valör+1 gün sonra yatar. Bu yüzden
-- işleme saat, fona da valör günü eklendi. Hesaplama uygulamada
-- (src/lib/settlement.ts); burada yalnızca veri saklanır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- İşlem saati — boşsa fonlarda 13:00 öncesi sayılır
alter table public.trades
  add column if not exists trade_time time;

comment on column public.trades.trade_time is
  'Emrin verildiği saat (isteğe bağlı). Fon satışında 13:00 sınırı takas '
  'gününü bir gün ileri atar; hissede saat önemsiz (T+2).';

-- ---------------------------------------------------------------- 2
-- Valör: satış parasının kaç iş günü sonra geçtiği
--   null → türün varsayılanı (hisse 2, fon 2, diğerleri 0)
--   fonda 13:00 sonrası emirde +1 gün eklenir
alter table public.assets
  add column if not exists settle_days integer check (settle_days >= 0);

comment on column public.assets.settle_days is
  'Satış parasının hesaba geçtiği iş günü sayısı (valör). null ise türün '
  'varsayılanı: hisse 2, fon 2, döviz/altın/kripto 0. Fonda 13:00 sonrası +1.';

-- ---------------------------------------------------------------- 3
-- Bilinen fonlar
update public.assets set settle_days = 3 where upper(symbol) = 'TMV';
update public.assets set settle_days = 2 where upper(symbol) in ('TLY', 'DFI', 'THF', 'DOH');

-- Kontrol
--   select symbol, kind, settle_days from public.assets order by symbol;
