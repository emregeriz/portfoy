# Portföy & Varlık Takip

2 kişilik, manuel veri girişli, Supabase tabanlı portföy takip uygulaması.
React 18 + Vite + TypeScript + Tailwind + Recharts.

## Hızlı başlangıç

```bash
npm install
cp .env.example .env    # değerleri doldur
npm run dev
```

## 1. Supabase kurulumu

1. [supabase.com](https://supabase.com) → yeni proje (bölge: **Frankfurt / EU Central**).
2. **SQL Editor** → [`supabase/schema.sql`](supabase/schema.sql) dosyasının tamamını yapıştır ve çalıştır.
   Tablolar, RLS politikaları, view'lar ve yeni kullanıcı için otomatik `profiles` trigger'ı kurulur.
3. **Authentication → Providers → Email** → "Enable email signup" **kapat**.
4. **Authentication → Users → Add user** ile iki kullanıcıyı elle ekle
   (e-posta + şifre, "Auto confirm user" işaretli).
5. `profiles` tablosundaki satırlar trigger sayesinde otomatik oluşur.
   `display_name` ve `color` alanlarını istediğin gibi düzenle:

   ```sql
   update profiles set display_name = 'Ahmet', color = '#4f8cff' where id = '...';
   update profiles set display_name = 'Mehmet', color = '#22c55e' where id = '...';
   ```

6. **Settings → API** → `Project URL` ve `anon public` anahtarını `.env` dosyasına yaz:

   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```

> `anon key` public'tir, sorun değil — güvenliği RLS sağlar.
> **`service_role` anahtarını asla frontend'e koyma.**

## 1b. Otomatik fiyat çekme

Adet girdiğin kalemlerin tutarı güncel fiyattan hesaplanır. Kaynaklar:

| Tür | Kaynak | Not |
|---|---|---|
| Döviz | TCMB `today.xml` | Resmî, hafta içi ~15:30 |
| Altın / gümüş | Truncgil | Gram, çeyrek, yarım, tam, ons, has |
| Kripto | CoinGecko | Ücretsiz, anahtar gerekmez |
| BIST hisse | Yahoo Finance | Sembol + `.IS` |
| Fon (TEFAS) | [Fonoloji](https://fonoloji.com/api-docs) | API anahtarı gerekir |

Bu kaynaklar CORS göndermediği için tarayıcıdan doğrudan çağrılamaz;
çekme işini `supabase/functions/fetch-prices` Edge Function'ı yapar.

### Kurulum

1. **SQL Editor** → [`supabase/prices.sql`](supabase/prices.sql) çalıştır
   (`asset_prices` tablosu, `v_latest_prices` / `v_latest_fx` görünümleri).
2. Fon fiyatı istiyorsan [fonoloji.com](https://fonoloji.com/api-docs) → ücretsiz
   API anahtarı al (15.000 kayıt/ay).
3. Edge Function'ı kur:

   ```bash
   npx supabase link --project-ref <proje-ref>
   npx supabase secrets set FONOLOJI_API_KEY=fon_...
   npx supabase functions deploy fetch-prices
   ```

   CLI kullanmak istemezsen: **Edge Functions → Deploy a new function** →
   dosyanın içeriğini yapıştır; anahtarı **Edge Functions → Secrets**'a ekle.
4. İsteğe bağlı — günlük otomatik çalıştırma için
   [`supabase/cron.sql`](supabase/cron.sql) (önce `pg_cron` + `pg_net` eklentilerini aç).

### Kullanım

- **Yeni Giriş → "↻ Güncel fiyatları çek"** — adet girilmiş satırların tutarını
  `adet × birim fiyat` yapar, döviz satırlarında kuru tazeler.
- **Dashboard → "Şu Anki Tahmini Değer"** — son snapshot'ın adetleri bugünkü
  fiyatlarla değerlenir; snapshot oluşturmadan güncel durumu gösterir.

Bir varlığın sembolü kaynaktaki adla eşleşmiyorsa `assets.price_ref` alanına
kaynağın kimliğini yaz (örn. kripto için CoinGecko id'si, hisse için `THYAO.IS`).
Otomasyonun dokunmasını istemediğin varlıkta `assets.auto_price = false` yap.

## 2. Güvenlik modeli

Herkes her şeyi **okur**, sadece kendi satırını **yazar**. `positions`, `snapshots`,
`accounts`, `liabilities`, `receivables`, `transactions`, `ipo_participations`
tablolarında `auth.uid() = user_id` koşulu geçerli. `assets` ve `fx_rates` ortak katalogdur.

## 3. Sayfalar

| Rota | İçerik |
|---|---|
| `/login` | E-posta + şifre girişi (kayıt kapalı) |
| `/` | Dashboard: toplam varlık/borç/net değer, zaman serisi, dağılım grafikleri |
| `/snapshot/new` | Yeni giriş — kalem kalem, canlı toplam, "son kayıttan kopyala" |
| `/snapshot/:id/edit` | Mevcut kaydı düzenle |
| `/history` | Snapshot listesi, detay açılır satır, düzenle/sil |
| `/accounts` | Banka/kurum yönetimi + güncel bakiye ve pay |
| `/ipo` | Halka arz takibi, hesap sahibi & duruma göre filtre, özet kartlar |
| `/transactions` | Gelir/gider, aylık kategori bazlı stacked bar |
| `/debts` | Verdiğim borçlar / borçlarım, kişi bazlı toplam |
| `/compare` | İki kullanıcının net değer eğrisi |

## 4. Netlify deploy

1. Projeyi GitHub'a push et.
2. Netlify → **Add new site → Import from Git** → repoyu seç.
3. Build command `npm run build`, publish dir `dist` (zaten `netlify.toml` içinde).
4. **Site settings → Environment variables** → `VITE_SUPABASE_URL` ve
   `VITE_SUPABASE_ANON_KEY` ekle → Deploy.

SPA yönlendirmesi `netlify.toml` içindeki `/*  →  /index.html  200` kuralı ile çözülür.

## 5. Kullanım akışı

1. **Hesaplar** sayfasından banka / aracı kurum / nakit hesaplarını ekle.
2. **Yeni Giriş** ile ilk snapshot'ı gir: her satır bir kalem
   (`Hesap · Varlık · Tür · Adet · Tutar · Birim · Kur · Not`).
3. Sonraki hafta/ay yine **Yeni Giriş** → **"Son kayıttan kopyala"** → sadece rakamları güncelle → Kaydet.
4. Dashboard'da net değer eğrisi ve dağılım grafikleri kendiliğinden dolar.

Döviz kalemlerinde `Kur` alanına o tarihteki TRY kurunu gir; `amount_try` veritabanında
`amount * fx_rate` olarak otomatik hesaplanır. TRY seçildiğinde kur 1'e sabitlenir.

## 6. Yol haritası

- [x] Faz 1 — Supabase + RLS, login, hesaplar, snapshot girişi, dashboard
- [x] Faz 2 — periyot filtreleri, pie + bar grafikler, son kayıttan kopyala, geçmiş & düzenleme
- [x] Faz 3 — halka arz, gelir/gider, borç & alacak, çoklu para birimi
- [x] Faz 4a — karşılaştırma grafiği
- [ ] Faz 4b — CSV dışa aktarım, otomatik kur çekme (TCMB), PWA

## Komutlar

```bash
npm run dev       # geliştirme sunucusu
npm run build     # tsc -b && vite build → dist/
npm run preview   # build çıktısını önizle
```
