import { useMemo } from 'react'
import { useNetWorth, useSnapshots, usePositionsForSnapshots } from './useSnapshots'
import { usePrices } from './usePrices'
import { useIpos } from './useIpos'
import { useCash } from './useCash'
import { useTable } from './useTable'
import { useCorporate } from './useCorporate'
import { TRADE_SELECT } from './useTrades'
import { ipoVirtualTrades } from '../lib/ipoTrades'
import { pendingRequests } from '../lib/ipoFunding'
import {
  allocationByAccount,
  allocationByKind,
  change,
  sumSeriesByDate,
  todayISO,
  KIND_LABELS,
} from '../lib/calc'
import {
  computeHoldings,
  holdingTotals,
  holdingsByAccount,
  holdingsByKind,
  holdingsSeries,
} from '../lib/holdings'
import type { AssetKind, Liability, TradeWithRefs } from '../types/db'

/**
 * Portföyün bugünkü resmi — Dashboard ve Hedef sayfası aynı kaynaktan okur.
 *
 * Toplam varlık = snapshot kalemleri (güncel fiyatla) + alım/satım
 * pozisyonları + hesaplardaki nakit + arz hesapları + arzda bloke para.
 * Net değer = toplam varlık − (snapshot borçları + açık borç/fatura).
 * Dağılım grafikleri, fon/hisse kâr listesi ve borç uyarıları da buradan
 * çıkar; iki ekranın farklı sayı göstermemesi için hesap tek yerde durur.
 *
 * `scope`: kullanıcı kimliği ya da 'toplam' (bütün kullanıcılar).
 */
export function usePortfolio(scope: string) {
  const isTotal = scope === 'toplam'

  const { rows, error } = useNetWorth(isTotal ? null : scope)
  const { snapshots } = useSnapshots(isTotal ? null : scope)

  // Son ve bir önceki snapshot (bucketlanmamış ham seri üzerinden)
  const raw = useMemo(() => (isTotal ? sumSeriesByDate(rows) : rows), [rows, isTotal])
  const last = raw[raw.length - 1] ?? null
  const prev = raw[raw.length - 2] ?? null

  // Son snapshot'ın kalemleri — dağılım grafikleri için
  const latestSnapshotIds = useMemo(() => {
    if (!last) return []
    if (!isTotal) {
      const s = snapshots.find((x) => x.snapshot_date === last.snapshot_date)
      return s ? [s.id] : []
    }
    // Toplam: her kullanıcının en son snapshot'ı
    const byUser = new Map<string, { id: string; date: string }>()
    for (const r of rows) {
      const cur = byUser.get(r.user_id)
      if (!cur || r.snapshot_date > cur.date) byUser.set(r.user_id, { id: r.snapshot_id, date: r.snapshot_date })
    }
    return [...byUser.values()].map((v) => v.id)
  }, [last, snapshots, rows, isTotal])

  const { positions, loading: posLoading } = usePositionsForSnapshots(latestSnapshotIds)
  const { byAssetId, bySymbol, latestDate, refreshing, refresh, error: priceError } = usePrices()

  /**
   * Alım/satım defteri. Buradaki semboller snapshot kalemlerinden ayrı
   * sayılır; ikisinde birden geçen varlık çift sayılmasın diye snapshot
   * tarafı bu semboller için yok sayılır (aşağıda tradedAssetIds).
   */
  const { rows: trades } = useTable<TradeWithRefs>('trades', {
    userId: isTotal ? null : scope,
    orderBy: 'trade_date',
    select: TRADE_SELECT,
  })

  const {
    ipos, entries, ledger: ipoLedger, accounts: ipoAccountRows, ipoAccounts,
    balanceOf: ipoBalanceOf, totalWaiting, blockedTotal,
  } = useIpos(isTotal ? null : scope)
  /**
   * Arz dağıtım/satışları sanal işlem olarak deftere katılır — arz hisseleri
   * yalnızca burada sayılır, ayrıca "elde tutulan arz" kalemi yoktur.
   */
  const virtualTrades = useMemo(
    () => ipoVirtualTrades(ipos, entries, ipoAccountRows),
    [ipos, entries, ipoAccountRows]
  )
  const allTrades = useMemo(() => [...trades, ...virtualTrades], [trades, virtualTrades])

  const tradedAssetIds = useMemo(
    () => new Set(trades.map((t) => t.asset_id).filter(Boolean) as string[]),
    [trades]
  )
  /** Snapshot kalemlerinden, alım/satım defterinde de olanları çıkar */
  const snapshotPositions = useMemo(
    () => positions.filter((p) => !p.asset_id || !tradedAssetIds.has(p.asset_id)),
    [positions, tradedAssetIds]
  )

  // Bedelsiz/bölünme ve temettü Alım/Satım sayfasıyla aynı şekilde işlenmeli,
  // yoksa iki sayfa farklı adet ve farklı kâr gösterir
  // "toplam" sekmesi bir kullanıcı değil; sorgu UUID beklediği için boş geçilir
  const corporate = useCorporate(isTotal ? null : scope)

  /**
   * Kendi hesaplarındaki nakit — Nakit sayfasının toplamı (halka arz hariç).
   *
   * Arz hesapları bilerek dışarıda: onların bakiyesi `totalWaiting` olarak
   * ayrıca toplanıyor, buraya da girerse para iki kez sayılır.
   */
  const { totals: cashTotals, accounts: cashAccounts } = useCash(isTotal ? null : scope)

  /**
   * Arz hesabı bazında nakit: hesapta duran para + o hesaptan arzda bloke
   * duran para. Bloke, `talep` satırıyla bakiyeden düşmüştür ama kaybolmadı —
   * Hesaplar sayfası da hesabın payını böyle hesaplıyor.
   */
  const ipoCashByAccount = useMemo(() => {
    const nameOf = new Map(ipoAccountRows.map((a) => [a.id, a.name]))
    const m = new Map<string, number>()
    const add = (name: string | undefined, value: number) => {
      if (!name || !value) return
      m.set(name, (m.get(name) ?? 0) + value)
    }
    for (const a of ipoAccounts) add(a.name, ipoBalanceOf.get(a.id) ?? 0)
    for (const p of pendingRequests(ipos, entries, ipoLedger)) add(nameOf.get(p.accountId), p.blocked)
    return m
  }, [ipoAccountRows, ipoAccounts, ipoBalanceOf, ipos, entries, ipoLedger])

  /** Toplam nakit: kendi hesapların + arz hesapları + arzda bloke bekleyen */
  const cashTotal = cashTotals.cash + totalWaiting + blockedTotal

  const holdings = useMemo(
    () =>
      computeHoldings(allTrades, bySymbol, {
        actions: corporate.actions,
        dividends: corporate.dividends,
      }),
    [allTrades, bySymbol, corporate.actions, corporate.dividends]
  )
  const tradeTotals = useMemo(() => holdingTotals(holdings), [holdings])
  const tradeSeries = useMemo(
    () => holdingsSeries(allTrades, bySymbol, todayISO(), undefined, corporate.actions),
    [allTrades, bySymbol, corporate.actions]
  )

  /** Snapshot kalemleri + alım/satım pozisyonları + hesaplardaki nakit */
  const byKind = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of allocationByKind(snapshotPositions)) map.set(s.key, s.value)
    for (const h of holdingsByKind(holdings)) map.set(h.key, (map.get(h.key) ?? 0) + h.value)
    // Nakit de bir varlık türü: Toplam Varlık'a giriyorsa pastada da payı olmalı,
    // yoksa dilimlerin toplamı üstteki karttan az çıkar.
    if (cashTotal) map.set('nakit', (map.get('nakit') ?? 0) + cashTotal)
    return [...map.entries()]
      .map(([key, value]) => ({
        key,
        label: key === 'nakit' ? 'Nakit' : KIND_LABELS[key as AssetKind] ?? key,
        value,
      }))
      .filter((s) => s.value !== 0)
      .sort((a, b) => b.value - a.value)
  }, [snapshotPositions, holdings, cashTotal])

  const byAccount = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of allocationByAccount(snapshotPositions)) map.set(s.key, s.value)
    for (const h of holdingsByAccount(allTrades, holdings)) {
      map.set(h.key, (map.get(h.key) ?? 0) + h.value)
    }
    // Hesaptaki nakit de dağılıma katılır — Hesaplar sayfasıyla aynı kaynak
    // (account_ledger). Katılmazsa nakit tutan hesap olduğundan küçük görünür.
    for (const a of cashAccounts) {
      if (a.balance) map.set(a.name, (map.get(a.name) ?? 0) + a.balance)
    }
    // Arz hesapları da: bakiyeleri + o hesaptan arzda bloke duran para
    for (const [name, value] of ipoCashByAccount) {
      map.set(name, (map.get(name) ?? 0) + value)
    }
    return [...map.entries()]
      .map(([key, value]) => ({ key, label: key, value }))
      .filter((s) => s.value !== 0)
      .sort((a, b) => b.value - a.value)
  }, [snapshotPositions, allTrades, holdings, cashAccounts, ipoCashByAccount])

  /** Fon/sembol bazlı vergi sonrası toplam kazanç */
  const fundProfit = useMemo(
    () =>
      holdings
        .map((h) => ({
          key: h.symbol,
          label: h.symbol,
          value: h.realizedNet + (h.unrealized ?? 0) - (h.potentialTax ?? 0),
        }))
        .filter((s) => Math.abs(s.value) > 0.005)
        .sort((a, b) => b.value - a.value),
    [holdings]
  )
  const fundProfitTotal = useMemo(
    () => fundProfit.reduce((s, f) => s + f.value, 0),
    [fundProfit]
  )
  const netChange = change(last?.net_worth_try ?? 0, prev?.net_worth_try)

  /**
   * Snapshot'a bağlı olmayan açık borçlar — kredi kartı, fatura vb.
   * Snapshot'a bağlı olanlar zaten total_liabilities_try içinde sayılıyor,
   * o yüzden yalnızca bağımsız kayıtlar buraya giriyor.
   */
  const { rows: allLiabilities } = useTable<Liability>('liabilities', {
    userId: isTotal ? null : scope,
  })
  const openDebts = useMemo(
    () => allLiabilities.filter((l) => !l.is_settled && l.snapshot_id === null),
    [allLiabilities]
  )
  const openDebtTotal = useMemo(
    () => openDebts.reduce((s, l) => s + Number(l.amount) * Number(l.fx_rate ?? 1), 0),
    [openDebts]
  )
  const todayStr = new Date().toISOString().slice(0, 10)
  /** Vadesi 7 gün içinde dolan ya da geçmiş ödemeler */
  const dueSoon = useMemo(() => {
    const limit = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
    return openDebts
      .filter((l) => l.due_date && l.due_date <= limit)
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
  }, [openDebts])

  /**
   * Son snapshot'taki adetler güncel fiyatlarla değerlenir.
   * Adedi veya fiyatı olmayan kalemler snapshot'taki tutarıyla sayılır.
   */
  const live = useMemo(() => {
    if (!snapshotPositions.length) return null
    let total = 0
    let priced = 0
    for (const p of snapshotPositions) {
      const lp = p.asset_id ? byAssetId.get(p.asset_id) : undefined
      const qty = Number(p.quantity ?? 0)
      if (lp && qty > 0) {
        total += qty * Number(lp.price)
        priced++
      } else {
        total += Number(p.amount_try ?? 0)
      }
    }
    return { total, priced, count: snapshotPositions.length }
  }, [snapshotPositions, byAssetId])

  // Talebi verilmiş arzda bloke duran para hesap bakiyesinden düşmüştür ama
  // kaybolmamıştır — dağıtım gününe kadar aracı kurumda bekler. Toplam
  // varlığa geri eklenmezse talep verdiğin gün servetin talep kadar düşmüş
  // görünür, dağıtım günü de aynı kadar zıplar.
  const liveAssets =
    (live?.total ?? (tradedAssetIds.size ? 0 : last?.total_assets_try ?? 0)) +
    totalWaiting +
    blockedTotal +
    tradeTotals.value +
    cashTotals.cash
  const showLive =
    (live && live.priced > 0) ||
    totalWaiting > 0 ||
    blockedTotal > 0 ||
    openDebtTotal > 0 ||
    tradeTotals.value > 0 ||
    cashTotals.cash > 0
  const totalDebt = (last?.total_liabilities_try ?? 0) + openDebtTotal
  const liveNet = showLive ? liveAssets - totalDebt : null
  const liveChange = liveNet != null ? change(liveNet, last?.net_worth_try) : null

  return {
    // kapsam / snapshot
    isTotal, error, last, prev, netChange,
    // fiyat
    posLoading, latestDate, refreshing, refresh, priceError,
    // pozisyonlar ve dağılım
    holdings, tradeTotals, tradeSeries, byKind, byAccount, fundProfit, fundProfitTotal,
    // nakit
    cashTotals, cashTotal, totalWaiting, blockedTotal,
    // borç
    openDebts, openDebtTotal, dueSoon, todayStr,
    // bugünkü resim
    live, liveAssets, showLive, totalDebt, liveNet, liveChange,
  }
}
