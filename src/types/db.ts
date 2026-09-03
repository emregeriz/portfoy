export type Currency = 'TRY' | 'USD' | 'EUR' | 'XAU' | 'GBP'
export type AccountType = 'banka' | 'aracikurum' | 'nakit' | 'kripto' | 'diger'
export type AssetKind = 'hisse' | 'fon' | 'doviz' | 'altin' | 'mevduat' | 'kripto' | 'diger'
export type LiabilityType = 'kredi_karti' | 'kredi' | 'kisisel_borc' | 'fatura' | 'diger'
export type TxDirection = 'gelir' | 'gider'
export type TxCategory = 'fatura' | 'seyahat' | 'market' | 'kira' | 'maas' | 'kk_odeme' | 'diger'
export type IpoStatus = 'talep_verildi' | 'dagitildi' | 'satildi' | 'iptal'

export interface Profile {
  id: string
  display_name: string
  base_currency: string
  color: string | null
  /** Üst menüde gizlenecek sayfa anahtarları — kullanıcıya özel menü */
  nav_hidden: string[]
  created_at: string
}

export interface Account {
  id: string
  user_id: string
  name: string
  type: AccountType
  currency: Currency
  is_active: boolean
  note: string | null
  /** Yıllık nemalandırma oranı — yüzde olarak (Midas: 34,5). 0 ise faiz işlemez */
  nema_rate: number
  /** Nemalandırmanın başladığı gün; boşsa ilk para hareketinden itibaren */
  nema_start: string | null
  /** Halka arz için kullanılan hesap — Halka Arz sayfası bunları listeler */
  is_ipo: boolean
  created_at: string
}

export interface Asset {
  id: string
  user_id: string | null
  symbol: string
  name: string | null
  kind: AssetKind
  /**
   * Satış kazancından kesilen stopaj oranı, kesir olarak (0,175 = %17,5).
   * null ise türün varsayılanı geçerli: fonda %17,5, hissede 0. Hisse senedi
   * yoğun fon TEFAS'ta fon görünür ama stopajsızdır — o ayrım buraya yazılır.
   */
  tax_rate: number | null
  created_at: string
}

export interface Snapshot {
  id: string
  user_id: string
  snapshot_date: string
  note: string | null
  created_at: string
}

export interface TakipExpense {
  desc: string
  amount: number
}

export type CashKind = 'gelir' | 'gider'

/** Takip sayfası — ek giderlerden bağımsız gelir/gider kalemleri */
export interface GelirGider {
  id: string
  user_id: string
  entry_date: string
  kind: CashKind
  title: string
  amount: number
  created_at: string
}

export interface TakipEntry {
  id: string
  user_id: string
  entry_date: string
  items: Record<string, number>
  debt: number
  expenses: TakipExpense[]
  note: string | null
  created_at: string
}

export interface Position {
  id: string
  snapshot_id: string
  user_id: string
  account_id: string | null
  asset_id: string | null
  quantity: number | null
  unit_price: number | null
  amount: number
  currency: Currency
  fx_rate: number
  amount_try: number
  note: string | null
  created_at: string
}

export interface PositionWithRefs extends Position {
  accounts: Pick<Account, 'id' | 'name' | 'type'> | null
  assets: Pick<Asset, 'id' | 'symbol' | 'name' | 'kind'> | null
}

export interface Liability {
  id: string
  user_id: string
  snapshot_id: string | null
  title: string
  type: LiabilityType
  counterparty: string | null
  amount: number
  currency: Currency
  fx_rate: number
  due_date: string | null
  is_settled: boolean
  /** Açıksa vadesi geçince bir sonraki ay otomatik açılır */
  repeat_monthly: boolean
  /** Aynı faturanın aylık kopyalarını birbirine bağlar */
  series_id: string | null
  /** Aynı gün ikinci kez mail gitmesin diye */
  last_reminded_on: string | null
  note: string | null
  created_at: string
}

export interface Receivable {
  id: string
  user_id: string
  person: string
  amount: number
  currency: Currency
  fx_rate: number
  given_date: string
  expected_date: string | null
  is_collected: boolean
  collected_date: string | null
  /** Parayı hangi hesaptan verdim — bakiyeden o hesap düşüldü */
  account_id: string | null
  /** Geri aldığımda hangi hesaba yattı */
  collected_account_id: string | null
  note: string | null
  created_at: string
}

export interface Transaction {
  id: string
  user_id: string
  account_id: string | null
  date: string
  direction: TxDirection
  category: TxCategory
  title: string
  amount: number
  currency: Currency
  fx_rate: number
  note: string | null
  created_at: string
}

export interface Ipo {
  id: string
  user_id: string
  ipo_name: string
  ipo_date: string | null
  account_owner: string | null
  broker: string | null
  requested_amount: number | null
  allocated_lot: number | null
  cost_price: number | null
  total_cost: number
  status: IpoStatus
  sold_date: string | null
  sold_price: number | null
  profit: number
  shared_with: string | null
  note: string | null
  created_at: string
}

export interface NetWorthRow {
  snapshot_id: string
  user_id: string
  snapshot_date: string
  total_assets_try: number
  total_liabilities_try: number
  net_worth_try: number
}

// --------------------------------------------------------------------
// Halka arz — arz, hesap katılımı ve hesaplardaki para hareketleri
// (eski ipo_participations tablosu yerini bu üçlüye bıraktı)
// --------------------------------------------------------------------
export type IpoState = 'talep_verildi' | 'dagitildi' | 'islemde' | 'satildi' | 'iptal'
export type LedgerKind =
  | 'giris' | 'iade' | 'satis' | 'transfer' | 'cikis'
  | 'cekim' | 'nema' | 'borc' | 'tahsil' | 'alim' | 'temettu' | 'talep' | 'diger'

export interface IpoRow {
  id: string
  user_id: string
  name: string
  bist_code: string | null
  ipo_date: string | null
  lot_price: number | null
  /** Arz takviminden otomatik açıldıysa ipo_feed kaydının slug'ı */
  feed_slug: string | null
  /** manuel = elle girildi · takvim = fetch-halkarz otomatik açtı */
  source: 'manuel' | 'takvim'
  /** Her hesaptan talep edilen lot — hesap işaretlenince bu yazılır */
  default_lot: number | null
  /** Borsada işlem görmeye başladığı gün */
  trade_start_date: string | null
  status: IpoState
  manual_price: number | null
  sold_date: string | null
  sold_price: number | null
  note: string | null
  created_at: string
}

export interface IpoEntry {
  id: string
  user_id: string
  ipo_id: string
  account_id: string
  requested_lot: number
  participated: boolean
  allocated_lot: number
  /** Bu hesaptan satılan lot — kalan kısım elde tutuluyor demektir */
  sold_lot: number
  sold_price: number | null
  sold_date: string | null
  created_at: string
}

/** v_ipo_entries — tutarlar arzın lot fiyatından türetilir */
export interface IpoEntryView extends Omit<IpoEntry, 'created_at'> {
  account_name: string
  ipo_name: string
  bist_code: string | null
  status: IpoState
  lot_price: number | null
  requested_amount: number
  cost: number
  refund: number
  proceeds: number
  realized_profit: number
  open_lot: number
}

/** v_ipo_account_summary — hangi hesaptan ne kadar kazandım */
export interface IpoAccountSummary {
  user_id: string
  account_id: string
  account_name: string
  ipo_count: number
  total_lot: number
  total_cost: number
  total_proceeds: number
  realized_profit: number
}

export interface LedgerRow {
  id: string
  user_id: string
  account_id: string
  ipo_id: string | null
  kind: LedgerKind
  /** + giriş, − çıkış */
  amount: number
  /** Borç verme / tahsilat hareketini alacak kaydına bağlar */
  receivable_id: string | null
  /** Alım/satım kaydına bağlı nakit hareketi — işlem silinince birlikte gider */
  trade_id: string | null
  date: string
  /** Aktarım çiftini eşleştirir — biri eksi biri artı */
  transfer_id: string | null
  note: string | null
  created_at: string
}

export interface AccountBalance {
  account_id: string
  balance: number
  last_move: string | null
  user_id: string
}

// --------------------------------------------------------------------
// halkarz.com arz takvimi önbelleği — fetch-halkarz Edge Function yazar
// --------------------------------------------------------------------
export interface IpoFeedDetail {
  tarih: string | null
  fiyat: string | null
  dagitim: string | null
  pay: string | null
  araci_kurum: string | null
  konsorsiyum: string[] | null
  bist_kodu: string | null
  pazar: string | null
  ilk_islem: string | null
  /** Dağıtım sonuçları tablosu — ham metin satırları */
  sonuclar: string[][] | null
  ozet: { baslik: string; icerik: string }[] | null
  son_guncelleme: string | null
}

export interface IpoFeedItem {
  slug: string
  name: string
  bist_code: string | null
  badge: 'yeni' | 'gong' | 'ertelendi' | null
  is_draft: boolean
  date_text: string | null
  price_text: string | null
  url: string
  image_url: string | null
  sort_order: number
  detail: IpoFeedDetail | null
  detail_fetched_at: string | null
  updated_at: string
}

// --------------------------------------------------------------------
// Serbest hatırlatıcılar — tarihi gelince seçilen kanaldan gönderilir
// --------------------------------------------------------------------
export type RepeatMode = 'once' | 'monthly'

/** Hatırlatmanın nereden geleceği; 'both' ikisine birden gönderir. */
export type ReminderChannel = 'wa' | 'mail' | 'both'

export interface Reminder {
  id: string
  user_id: string
  title: string
  body: string | null
  next_date: string
  send_time: string
  repeat_mode: RepeatMode
  channel: ReminderChannel
  is_active: boolean
  last_sent_on: string | null
  created_at: string
}

// --------------------------------------------------------------------
// Alım / satım defteri — her işlem ayrı kayıt, pozisyon bunlardan türer
// --------------------------------------------------------------------
export type TradeSide = 'alis' | 'satis'

export interface Trade {
  id: string
  user_id: string
  account_id: string | null
  asset_id: string | null
  side: TradeSide
  trade_date: string
  quantity: number
  unit_price: number
  /** Gerçekleşen toplam tutar — adet × birim fiyattan küsurat farkı olabilir */
  amount: number
  currency: Currency
  fx_rate: number
  amount_try: number
  note: string | null
  created_at: string
}

export interface TradeWithRefs extends Trade {
  accounts: Pick<Account, 'id' | 'name' | 'type'> | null
  assets: Pick<Asset, 'id' | 'symbol' | 'name' | 'kind' | 'tax_rate'> | null
}
