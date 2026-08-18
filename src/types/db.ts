export type Currency = 'TRY' | 'USD' | 'EUR' | 'XAU' | 'GBP'
export type AccountType = 'banka' | 'aracikurum' | 'nakit' | 'kripto' | 'diger'
export type AssetKind = 'hisse' | 'fon' | 'doviz' | 'altin' | 'mevduat' | 'kripto' | 'diger'
export type LiabilityType = 'kredi_karti' | 'kredi' | 'kisisel_borc' | 'diger'
export type TxDirection = 'gelir' | 'gider'
export type TxCategory = 'fatura' | 'seyahat' | 'market' | 'kira' | 'maas' | 'kk_odeme' | 'diger'
export type IpoStatus = 'talep_verildi' | 'dagitildi' | 'satildi' | 'iptal'

export interface Profile {
  id: string
  display_name: string
  base_currency: string
  color: string | null
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
  created_at: string
}

export interface Asset {
  id: string
  user_id: string | null
  symbol: string
  name: string | null
  kind: AssetKind
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
