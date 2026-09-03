import type { Account, IpoEntry, IpoRow, TradeWithRefs } from '../types/db'

/**
 * Halka arz kayıtlarını alım/satım defterine "sanal işlem" olarak çevirir.
 *
 * Arz hisselerinin tek gerçek kaynağı Halka Arz modülüdür; trades tablosuna
 * elle girilmezler (çift sayım olur). Bu fonksiyon dağıtımı alış, hesap
 * bazlı satışı satış satırına çevirir — Alım/Satım, Dashboard ve Hesaplar
 * sayfaları bunları gerçek işlemlerle birlikte hesaplar. Arzda yapılan her
 * düzeltme buraya kendiliğinden yansır.
 */
export function ipoVirtualTrades(
  ipos: IpoRow[],
  entries: IpoEntry[],
  accounts: Account[]
): TradeWithRefs[] {
  const accById = new Map(accounts.map((a) => [a.id, a]))
  const out: TradeWithRefs[] = []

  for (const ipo of ipos) {
    const code = ipo.bist_code?.trim().toUpperCase()
    // Kodu olmayan arz pozisyona bağlanamaz; talep/iptal aşamasında hisse yok
    if (!code || ipo.status === 'talep_verildi' || ipo.status === 'iptal') continue
    const lotPrice = Number(ipo.lot_price ?? 0)
    const buyDate = ipo.trade_start_date ?? ipo.ipo_date ?? ipo.created_at.slice(0, 10)
    // Halka arz hissesi: satış kazancından stopaj kesilmez, oran türden gelir
    const assetRef = {
      id: `ipo-${code}`, symbol: code, name: ipo.name, kind: 'hisse' as const, tax_rate: null,
    }

    for (const e of entries) {
      if (e.ipo_id !== ipo.id || !e.participated) continue
      const alloc = Number(e.allocated_lot)
      if (!(alloc > 0)) continue
      const acc = accById.get(e.account_id)
      const accountRef = acc ? { id: acc.id, name: acc.name, type: acc.type } : null

      out.push({
        id: `ipo:${e.id}:alis`,
        user_id: e.user_id,
        account_id: e.account_id,
        asset_id: null,
        side: 'alis',
        trade_date: buyDate,
        quantity: alloc,
        unit_price: lotPrice,
        amount: alloc * lotPrice,
        currency: 'TRY',
        fx_rate: 1,
        amount_try: alloc * lotPrice,
        note: `${ipo.name} — halka arz dağıtımı`,
        created_at: e.created_at,
        accounts: accountRef,
        assets: assetRef,
      })

      const sold = Number(e.sold_lot ?? 0)
      if (sold > 0 && e.sold_price != null && e.sold_date) {
        const soldPrice = Number(e.sold_price)
        out.push({
          id: `ipo:${e.id}:satis`,
          user_id: e.user_id,
          account_id: e.account_id,
          asset_id: null,
          side: 'satis',
          trade_date: e.sold_date,
          quantity: sold,
          unit_price: soldPrice,
          amount: sold * soldPrice,
          currency: 'TRY',
          fx_rate: 1,
          amount_try: sold * soldPrice,
          note: `${ipo.name} — halka arz satışı`,
          created_at: e.created_at,
          accounts: accountRef,
          assets: assetRef,
        })
      }
    }
  }
  return out
}

/** Satır Halka Arz modülünden mi türedi? Böyleyse düzenlenemez/silinemez. */
export const isIpoTrade = (t: TradeWithRefs) => t.id.startsWith('ipo:')
