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

## 1c. Nakit & nemalandırma

Hesaplardaki para `account_ledger` defterinde tutulur: elle **para girişi /
çıkışı**, hesaplar arası **aktarım**, halka arz **iadesi / satış geliri** ve
günlük **nema** aynı tabloya yazılır. Hesabın bakiyesi bu hareketlerin
toplamıdır.

### Kurulum

**SQL Editor** → [`supabase/cash.sql`](supabase/cash.sql) çalıştır. Kurduğu şey:

- `accounts.nema_rate` (yıllık yüzde) ve `accounts.nema_start` kolonları
- `account_ledger.kind` içine `giris` ve `nema` türleri
- aynı hesaba aynı gün ikinci faiz satırı yazılmasını engelleyen tekil indeks
- `v_nema_daily` görünümü ve `v_account_balances`'a `user_id` kolonu

### Nemalandırma nasıl işler

Bir hesaba yıllık oran tanımlarsan (Midas için **%34,5**) o hesaptaki nakde
her gün faiz işler:

```
günlük faiz = gün sonu bakiye × oran ÷ 365
```

Faiz bakiyeye eklenir, ertesi gün faizin üzerine faiz yürür — yani bileşiktir.
%34,5 yıllık oran bileşikle yıl sonunda ~%41,2 eder. Hesap tarayıcıda,
uygulama her açıldığında yapılır: bir hafta girmezsen açtığında o yedi günün
faizi ayrı satırlar hâlinde geriye dönük tamamlanır. Yazılan tutar **brüttür**,
stopaj düşülmez.

Matematiği `npm run test:nema` ile doğrulayabilirsin.

### Bugünün getirisi

Üst çubuğun sağındaki rozet, o günkü kazancı gösterir — kârda yeşil, zararda
kırmızı. Hesabın tamamı tek yerde: `src/lib/dailyReturn.ts`. Günlük Kâr sayfası
da aynı motordan beslenir, iki ekran hiçbir zaman farklı sayı göstermez.

Bir günün kazancı üç parçaya ayrılır:

| Parça | Hesap |
|---|---|
| Gün boyu elde tutulan pay | adet × (o günün kapanışı − önceki kapanış) |
| **O gün satılan pay** | adet × (gerçekleşen **satış fiyatı** − önceki kapanış) |
| O gün alınan pay | adet × (o günün kapanışı − kendi alış fiyatı) |

Satış parçası işin can alıcı yeri: bir kâğıdı sattıysan o günkü kazancının gün
sonu fiyatıyla ilgisi kalmaz — para hangi fiyattan çıktıysa kazanç odur. Halka
arzda her hesap ayrı fiyattan satılabildiği için satışlar **hesap hesap** ayrı
kalem tutulur:

```
CITAS · Nalin    32 lot   107,80 → 103,00    −153,60
CITAS · Yusuf    32 lot   107,80 → 105,00     −89,60
CITAS · Yaren    32 lot   107,80 → 110,60     +89,60
CITAS · Furkan   32 lot   107,80 → 108,30     +16,00
```

"Önceki kapanış" takvim günü değil bir önceki **fiyat günü**dür: pazartesi
satılan kâğıt cumanın kapanışıyla kıyaslanır, araya hafta sonu girmesi hesabı
bozmaz.

Üzerine o gün hesaplara işleyen **nema** ve tahsil edilen **net temettü** eklenir.
Toplam şu kimliğe eşittir:

```
gün kârı = (gün sonu değer + gün içi satış geliri)
         − (gün başı değer + gün içi alış maliyeti)
```

yani araya konan/çıkan para kâr sayılmaz. Bir kâğıdın günlük kârları ömrü
boyunca toplandığında gerçekleşen kâra birebir oturur — CITAS örneğinde
940,80 + 1.036,80 + 1.139,20 + 1.248,00 − 137,60 = **4.227,20**, Halka Arz
sayfasındaki "gerçekleşen kâr" ile aynı kuruş.

Halka arza özel iki kural: **ilk işlem gününde** borsada önceki kapanış
olmadığı için referans halka arz fiyatıdır (para o güne dek orada bağlıydı),
fiyatı elle girilen arzlar (`manual_price`) ise günlük değişim üretmez.

Tıklayınca kırılım açılır: kalemler, o gün gerçekleşen satışlar ve en çok
oynayan semboller. **Bugün için fiyat gelmediyse** (hafta sonu, tatil ya da
sabah 10:00 çekiminden önce) o gün yalnızca gerçekleşen hareketler sayılır;
rozet en son hangi günde ne olduğunu ayrıca yazar. Aynı hareketin iki güne
birden yazılmaması için fiyat günü kaydırılmaz.

**Önceki gün fiyatı olmayan kalem sayılamaz** — yeni eklenen bir fonun/hissenin
veritabanında tek günlük fiyatı olur. Rozet bunu "N kalem sayılamadı" diye
söyler. Fiyat çekimi bunu kendi kendine onarır: `fetch-prices`, iki günden az
fiyatı olan fonun geçmişini Fonoloji `history` uç noktasından çeker, hisselerde
ise Yahoo'nun zaten aynı yanıtta verdiği 1 aylık günlük seriyi yazar. Elle
tetiklemek için Dashboard → **↻ Fiyatları güncelle**; bütün fonların geçmişini
yeniden çekmek için fonksiyona `{ "backfill": true, "backfillPeriod": "3m" }`
gövdesiyle istek at.

### Günlük kâr defteri

`/gunluk` — her günün kazancı çubuk grafikte; kâr yeşil, zarar kırmızı.
"Birikimli" düğmesi aynı seriyi toplayarak çizer. Bir güne tıklayınca:

* **kalem kalem döküm** — hangi kâğıttan/hesaptan ne kadar geldi, o pay
  tutuldu mu, satıldı mı, alındı mı, hangi fiyattan hangi fiyata;
* **o gün elimde ne vardı** — gün sonundaki pozisyonlar, adetleri, o güne
  kadarki son fiyatla değerleri ve o günkü kâr/zararları.

Defter ayrı bir tabloya **kaydedilmez, deftere bakılarak türetilir**: fiyat
geçmişi, alım/satım defteri ve halka arz kayıtları zaten günlük çözünürlükte
duruyor. Böylece uygulamayı her gün açmasan da geçmiş eksiksiz çıkar ve geriye
dönük bir düzeltme (yanlış girilmiş satış fiyatı gibi) o günün kârına anında
yansır.

Terminalden aynı motoru çalıştırıp doğrulamak için:

```bash
npm run check:daily -- --user eposta@ornek.com                       # gün gün özet
npm run check:daily -- --user eposta@ornek.com --day 2026-08-24      # o günün kalemleri
```

Hangi kalemin ölçülebildiğini görmek için:

```bash
npm run check:prices   # sembol bazında kaç günlük fiyat geçmişi var, günlük fark ne
```

Bir günün fiyatı hiçbir kaynaktan gelmiyorsa elle yazılabilir:

```bash
npm run price:set -- --symbol DFI --date 2026-08-19 --price 5,486123        # kuru çalışma
npm run price:set -- --symbol DFI,THF --date 2026-08-19 --price 5,48;2,50 --yes
```

## 1d. Halka arz akışı

Halka arza kendi hesabının yanı sıra yakınlarının hesaplarından da giriyorsan,
o hesaplar **ayrı tutulur**: `accounts.is_ipo = true` olanlar yalnızca Halka Arz
sayfasında listelenir, Nakit ve Hesaplar sayfalarını kalabalıklaştırmaz. Yine de
bakiyeleri senin toplam varlığına girer — para senin.

Kurulum: **SQL Editor** → [`supabase/ipo-v2.sql`](supabase/ipo-v2.sql), ardından
[`supabase/ipo-talep.sql`](supabase/ipo-talep.sql) (talep blokesi — aşağıda).

### Adımlar

| Adım | Ne olur |
|---|---|
| **+ Hesap ekle** | Halka arz hesabı açılır (kimin hesabı olduğunu nota yaz) |
| **+ Arz Ekle** | Arz adı, BIST kodu, lot fiyatı ve **hesap başına istenen lot** girilir; aşağıdaki listede işaretlediğin her hesaba bu lot doğrudan yazılır |
| **Talep karşılığı** | Kaydedince kendiliğinden açılır: istenen lot × lot fiyatı her hesaptan **bloke** edilir, parasının yetmediği hesap için "hesaptaki parayla / kendi hesabımdan / dışarıdan" sorulur |
| **Dağıtıldı** | Tek kutuya eşit lot yazarsın (örn. 30 → herkese 30) ya da hesap hesap girersin. Kaydedince (istenen − düşen) × lot fiyatı her hesaba **iade** olarak yatar |
| **İşlem görmeye başladı** | İlk işlem gününü girersin. Bugün/geçmişse fiyat hemen çekilir; ileri tarihse o sabah **10:01**'de otomatik çekilir |
| **Sat** | Hesapları toplu işaretleyip tek fiyattan ya da satır satır ayrı ayrı satarsın. Gelir o hesabın bakiyesine yazılır |
| **Para aktar** | Hesapta biriken parayı kendi hesabına (ya da dışarı) aktarırsın |

Aynı adımı tekrar çalıştırmak parayı ikiye katlamaz: bloke, dağıtım ve satış
kayıtları silinip yeniden yazılır. Satışı yanlış fiyattan girdiysen "Satışı geri
al" ile hesabı açık pozisyona döndürebilirsin.

### Talep karşılığı — paranın iki yakası

Defter arzın **iki tarafını da** tutar. Talep verilirken hesaptan bloke edilen
tutar `talep` (−), dağıtımda geri yatan tutar `iade` (+) olarak yazılır:

```
talep (−)  istenen lot × lot fiyatı
iade  (+)  (istenen − düşen) × lot fiyatı
─────────────────────────────────────────
kalan (−)  düşen lot × lot fiyatı   = elindeki payın maliyeti
```

Hiç lot düşmezse ikisi birbirini götürür ve bakiye değişmez — hesapta zaten
duran parayla arza girmenin doğru karşılığı budur. Bloke tarafı yazılmazsa iade
yoktan var olmuş para gibi görünür ve bakiye iade kadar şişer.

`cikis`ten farkı: `cikis` para sistemden tamamen çıktı demektir ve net varlığı
azaltır. `talep` ise para hâlâ senin, yalnızca dağıtıma kadar aracı kurumda
bloke. Dashboard bunu **"arzda bloke"** satırıyla toplam varlığına geri ekler,
Halka Arz sayfası da ayrı bir kartta gösterir.

Hesabın parası talebi karşılamıyorsa "Talep karşılığı" ekranı açığı hesap hesap
gösterir ve kaynağını sorar:

| Seçim | Deftere yazılan | Toplam varlık |
|---|---|---|
| **Hesaptaki parayla** | hiçbir şey — para zaten oradaydı | değişmez |
| **Kendi hesabımdan attım** | transfer çifti (kaynaktan −, arz hesabına +) | değişmez |
| **Dışarıdan yatırdım** | `giris` (+) | açık kadar artar |

Bu ekran idempotenttir: ikinci kez açıp kaydetmek parayı iki kez atmaz, önceki
karşılık hareketleri silinip yenisi yazılır.

### Eski kayıtları düzeltme

Bu sürümden önce açılmış arzlarda bloke satırı yoktur; sayfa bunu arzın üstünde
sarı bir uyarıyla söyler ve "Talep karşılığını gir" ile tek tıkta düzeltir.
Hepsini birden düzeltmek için:

```bash
npm run fix:ipo -- --user eposta@ornek.com            # kuru çalışma, hiçbir şey yazmaz
npm run fix:ipo -- --user eposta@ornek.com --apply    # yazar
```

Betik elle "talep bloke" diye yazılmış `cikis` satırlarını tanıyıp `talep`e
çevirir (tutara dokunmaz), eksik blokeleri yazar ve bloke yüzünden geçmişte
eksiye düşen hesaplara açığı kapatacak kadar açılış girişi ekler — o para
hesapta zaten vardı, sadece kayda geçmemişti. Açılış girişi istemiyorsan
`--no-acilis` ver, hesap eksi kalır ve doğru kaynağı uygulamadan seçersin.

### Raporlar

- **Hesap Bazlı Kâr** — hangi hesaptan ne kadar kazandın, hesapta ne kadar para bekliyor
- **Arz Bazlı Kâr** — hangi arz ne getirdi (maliyet, iade, satış geliri, kâr)
- **Dashboard → Halka arz iadesi** — bütün hesaplarda çekilmeyi bekleyen toplam para,
  hesap hesap değil tek satır
- **Dashboard → Arzda bloke** — talebi verilmiş, dağıtımı beklenen para; hesaptan
  düşmüştür ama senindir, toplam varlığa sayılır

## 2. Güvenlik modeli

Her kullanıcı **yalnızca kendi verisini** görür ve yazar. `accounts`, `snapshots`,
`positions`, `liabilities`, `receivables`, `transactions`, `trades`, `ipos`,
`ipo_entries`, `account_ledger`, `takip_*`, `gelir_gider`, `reminders`
tablolarında hem okuma hem yazma politikası `auth.uid() = user_id`; `profiles`
için `auth.uid() = id`. Kurulum: [`supabase/rls-per-user.sql`](supabase/rls-per-user.sql).

İstisnalar piyasa verisidir: `asset_prices` ve `fx_rates` herkese açık okunur
(kişiye özel bilgi taşımaz), `assets` ise ortak katalog (`user_id` boş satırlar)
artı kendi eklediğin semboller olarak okunur. Edge Function'lar `service_role`
ile bağlandığı için RLS'i baypas eder — fiyat çekimi ve hatırlatma mailleri
etkilenmez.

> Görünümler (`v_account_balances`, `v_ipo_entries`, `v_net_worth`…)
> `security_invoker = on` ile tanımlı; RLS'i taban tablolardan miras alırlar,
> ayrıca filtrelemeye gerek yoktur.

## 3. Sayfalar

| Rota | İçerik |
|---|---|
| `/login` | E-posta + şifre girişi (kayıt kapalı) |
| `/` | Dashboard: toplam varlık/borç/net değer, zaman serisi, dağılım grafikleri |
| `/takip` | Günlük takip tablosu (kullanıcıya göre gizlenebilir) |
| `/trades` | Alım / satım defteri, pozisyonlar, vergi sonrası kâr |
| `/accounts` | Banka/kurum yönetimi + güncel bakiye ve pay |
| `/nakit` | Hesaplardaki nakit, para giriş/çıkışı, aktarım, günlük nemalandırma |
| `/ipo` | Halka arz: hesap yönetimi, talep, dağıtım, hesap bazlı satış, kâr raporları |
| `/gunluk` | Günlük kâr: gün gün grafik, seçilen günün kalem dökümü ve o günkü pozisyonlar |
| `/transactions` | Gelir/gider, aylık kategori grafiği ve **verdiğin borçlar** |
| `/reminders` | Serbest hatırlatıcılar (profil menüsünden) |

### Kullanıcıya özel menü

Üst menü `profiles.nav_hidden` dizisine bakar: içindeki anahtarlar o
kullanıcının menüsünde görünmez. Anahtarlar `Layout.tsx`'teki NAV `key`
değerleridir (`dashboard`, `takip`, `trades`, `accounts`, `nakit`, `ipo`,
`transactions`). Kod değiştirmeden tek SQL ile ayarlanır:

```sql
update profiles set nav_hidden = array['takip'] where display_name = 'emregeriz';
update profiles set nav_hidden = '{}'            where display_name = 'alperbuber800';
```

### Borç verme

Ayrı bir "Borç & Alacak" sayfası yok; borç verme Gelir/Gider sayfasındaki
kayıt formunun üçüncü türü. Seçince tutar **hangi hesaptan verdiysen onun
bakiyesinden düşer** (`account_ledger`, tür `borc`). Geri aldığında listedeki
"Aldım" düğmesiyle paranın yattığı hesabı seçersin, tutar oraya eklenir
(tür `tahsil`). Faizli ya da eksik geri aldıysan tutarı değiştirebilirsin.
Hareketler Nakit sayfasındaki defterde de görünür ama oradan silinemez —
kaynağı alacak kaydıdır.

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
npm run test:nema # nemalandırma hesabının testleri
npm run check:prices  # fiyat geçmişi sağlığı (salt okunur)
npm run check:daily -- --user eposta@ornek.com   # günlük kâr defteri (salt okunur)
npm run fix:ipo -- --user eposta@ornek.com      # arz talep blokelerini onar (kuru çalışma)
```
