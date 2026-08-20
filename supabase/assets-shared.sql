-- =====================================================================
-- assets = ortak sembol kataloğu
--
-- Sorun: `ensureAsset` sembolü ekleyen kullanıcının kimliğiyle yazıyordu.
-- Kullanıcı izolasyonu açılınca (rls-per-user.sql) başka bir hesapla
-- eklenmiş sembol —örneğin TLY— sahibi olmayan kullanıcıya görünmez oldu;
-- o kullanıcının işlemleri "fiyat yok" durumuna düştü.
--
-- Çözüm: sembol tablosu kişisel veri taşımaz (kod, ad, tür, kaynak
-- eşlemesi). Ortak katalog olarak paylaşılır; kimin hangi sembolde
-- pozisyonu olduğu zaten trades/positions tarafında ve kişiye özeldir.
--
-- rls-per-user.sql sonrası çalıştır.
-- =====================================================================

-- ---------------------------------------------------------------- 1
-- Mevcut sembolleri ortak kataloğa taşı
update public.assets set user_id = null where user_id is not null;

-- ---------------------------------------------------------------- 2
-- Yazma: ortak kataloğa da eklenebilsin (okuma politikası zaten
-- "user_id is null or auth.uid() = user_id")
drop policy if exists insert_own on public.assets;
drop policy if exists insert_shared on public.assets;
create policy insert_shared on public.assets for insert to authenticated
  with check (user_id is null or auth.uid() = user_id);

-- Ortak katalog satırları silinemez/değiştirilemez; yalnızca kendi
-- eklediğin özel satırlara dokunabilirsin.
drop policy if exists update_own on public.assets;
drop policy if exists delete_own on public.assets;
create policy update_own on public.assets for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy delete_own on public.assets for delete to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------- 3
-- Aynı sembol ortak katalogda iki kez bulunmasın
create unique index if not exists assets_symbol_uniq
  on public.assets(upper(symbol)) where user_id is null;
