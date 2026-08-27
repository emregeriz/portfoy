import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useNetWorth, useSnapshots, usePositionsForSnapshots } from '../hooks/useSnapshots'
import { usePrices } from '../hooks/usePrices'
import { useIpos } from '../hooks/useIpos'
import { ipoVirtualTrades } from '../lib/ipoTrades'
import { useCash } from '../hooks/useCash'
import { useTable } from '../hooks/useTable'
import { useCorporate } from '../hooks/useCorporate'
import { TRADE_SELECT } from '../hooks/useTrades'
import type { AssetKind, Liability, TradeWithRefs } from '../types/db'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import NetWorthChart from '../components/NetWorthChart'
import AllocationPie from '../components/AllocationPie'
import AccountBar from '../components/AccountBar'
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import {
  allocationByAccount,
  allocationByKind,
  change,
  sumSeriesByDate,
  todayISO,
  KIND_LABELS,
} from '../lib/calc'
import { formatNumber, formatPercent, formatTRY } from '../lib/currency'
import {
  computeHoldings,
  holdingTotals,
  holdingsByAccount,
  holdingsByKind,
  holdingsSeries,
  DEFAULT_TAX_RATE,
} from '../lib/holdings'

/** Fon - Hisse grafiğinde başta görünen kalem sayısı */
const FUNDS_SHOWN = 10

export default function Dashboard() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  /** Pozisyon grafiğinde vergi sonrası çizgisi — varsayılan gizli */
  const [showNetLine, setShowNetLine] = useState(false)
  /** Fon-hisse grafiğinde ilk 10'dan fazlasını göster */
  const [showAllFunds, setShowAllFunds] = useState(false)
  /** Fon-hisse kartında pozisyon dökümü — adet, değer, kâr */
  const [showFundDetail, setShowFundDetail] = useState(false)

  const effectiveScope = scope || user?.id || ''
  const isTotal = effectiveScope === 'toplam'

  const { rows, error } = useNetWorth(isTotal ? null : effectiveScope)
  const { snapshots } = useSnapshots(isTotal ? null : effectiveScope)

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
    userId: isTotal ? null : effectiveScope,
    orderBy: 'trade_date',
    select: TRADE_SELECT,
  })

  const { ipos, entries, accounts: ipoAccountRows, totalWaiting, blockedTotal } = useIpos(
    isTotal ? null : effectiveScope
  )
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
  const corporate = useCorporate(isTotal ? null : effectiveScope)

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

  /** Snapshot kalemleri + alım/satım pozisyonları tek dağılımda */
  const byKind = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of allocationByKind(snapshotPositions)) map.set(s.key, s.value)
    for (const h of holdingsByKind(holdings)) map.set(h.key, (map.get(h.key) ?? 0) + h.value)
    return [...map.entries()]
      .map(([key, value]) => ({ key, label: KIND_LABELS[key as AssetKind] ?? key, value }))
      .filter((s) => s.value !== 0)
      .sort((a, b) => b.value - a.value)
  }, [snapshotPositions, holdings])

  const byAccount = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of allocationByAccount(snapshotPositions)) map.set(s.key, s.value)
    for (const h of holdingsByAccount(allTrades, holdings)) {
      map.set(h.key, (map.get(h.key) ?? 0) + h.value)
    }
    return [...map.entries()]
      .map(([key, value]) => ({ key, label: key, value }))
      .filter((s) => s.value !== 0)
      .sort((a, b) => b.value - a.value)
  }, [snapshotPositions, allTrades, holdings])

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
  /** Grafikte önce mutlak değeri en büyük ilk 10 kalem; sıralama kâr düzeninde kalır */
  const fundProfitShown = useMemo(() => {
    if (showAllFunds || fundProfit.length <= FUNDS_SHOWN) return fundProfit
    return [...fundProfit]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, FUNDS_SHOWN)
      .sort((a, b) => b.value - a.value)
  }, [fundProfit, showAllFunds])

  const netChange = change(last?.net_worth_try ?? 0, prev?.net_worth_try)

  /** Kendi hesaplarındaki nakit — Nakit sayfasının toplamı (halka arz hariç) */
  const { totals: cashTotals } = useCash(isTotal ? null : effectiveScope)

  /**
   * Snapshot'a bağlı olmayan açık borçlar — kredi kartı, fatura vb.
   * Snapshot'a bağlı olanlar zaten total_liabilities_try içinde sayılıyor,
   * o yüzden yalnızca bağımsız kayıtlar buraya giriyor.
   */
  const { rows: allLiabilities } = useTable<Liability>('liabilities', {
    userId: isTotal ? null : effectiveScope,
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        subtitle={
          last
            ? `Son güncelleme: ${format(parseISO(last.snapshot_date), 'd MMMM yyyy', { locale: tr })}`
            : 'Henüz kayıt yok'
        }
        actions={
          <Link to="/trades" className="btn-primary">
            + İşlem ekle
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <UserTabs
          profiles={profiles}
          currentUserId={user?.id}
          value={effectiveScope}
          onChange={setScope}
        />
      </div>

      {error && <ErrorBox message={error} />}

      {dueSoon.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <div className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-1">
            Yaklaşan ödemeler
          </div>
          <ul className="space-y-0.5 text-xs">
            {dueSoon.map((l) => {
              const overdue = (l.due_date ?? '') < todayStr
              return (
                <li key={l.id} className="flex justify-between gap-3">
                  <span>
                    {l.title}
                    {l.counterparty ? ` · ${l.counterparty}` : ''}
                  </span>
                  <span className={`num ${overdue ? 'text-neg' : 'text-muted'}`}>
                    {formatTRY(Number(l.amount) * Number(l.fx_rate ?? 1))} ·{' '}
                    {overdue
                      ? 'gecikti'
                      : format(parseISO(l.due_date as string), 'd MMM', { locale: tr })}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Toplam Varlık"
          value={liveAssets}
          hint={
            tradeTotals.value > 0
              ? `${formatTRY(tradeTotals.value)} alım/satım pozisyonu dahil`
              : undefined
          }
        />
        <StatCard
          title="Toplam Borç"
          value={totalDebt}
          tone={totalDebt > 0 ? 'neg' : 'neutral'}
        />
        <StatCard
          title="Net Değer"
          value={liveNet ?? last?.net_worth_try ?? 0}
          change={netChange}
          tone={(liveNet ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <StatCard
          title="Vergi Sonrası Kazanç"
          value={tradeTotals.netProfit}
          tone={tradeTotals.netProfit >= 0 ? 'pos' : 'neg'}
          hint={
            tradeTotals.totalTax > 0
              ? `${formatTRY(tradeTotals.totalTax)} vergi düşüldü`
              : 'Alım/satım kaydı yok'
          }
        />
      </div>

      {showLive && (
        <Card
          title="Şu Anki Tahmini Değer"
          actions={
            <button className="btn-ghost text-xs" onClick={() => void refresh()} disabled={refreshing} type="button">
              {refreshing ? 'Güncelleniyor…' : '↻ Fiyatları güncelle'}
            </button>
          }
        >
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-2xl font-semibold text-ink">{formatTRY(liveNet ?? 0)}</p>
              <p className="text-xs text-muted">
                Net değer · son kayıt {formatTRY(last?.net_worth_try ?? 0)}
                {liveChange && liveChange.percent !== null && (
                  <span className={liveChange.absolute >= 0 ? ' text-pos' : ' text-neg'}>
                    {' '}({formatPercent(liveChange.percent)})
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-lg text-ink">{formatTRY(liveAssets)}</p>
              <p className="text-xs text-muted">Toplam varlık</p>
            </div>
            {openDebtTotal > 0 && (
              <div>
                <p className="text-lg text-neg">−{formatTRY(openDebtTotal)}</p>
                <p className="text-xs text-muted">Açık borç & fatura</p>
              </div>
            )}
            {tradeTotals.value > 0 && (
              <div>
                <p className="text-lg text-ink">{formatTRY(tradeTotals.value)}</p>
                <p className="text-xs text-muted">
                  Fon &amp; hisse pozisyonları ·{' '}
                  <span className={tradeTotals.unrealized >= 0 ? 'text-pos' : 'text-neg'}>
                    {formatTRY(tradeTotals.unrealized)} kâr
                  </span>
                </p>
              </div>
            )}
            {cashTotals.cash > 0 && (
              <div>
                <p className="text-lg text-ink">{formatTRY(cashTotals.cash)}</p>
                <p className="text-xs text-muted">
                  Hesaplardaki nakit
                  {cashTotals.todayNema > 0 && (
                    <span className="text-pos"> · bugün +{formatTRY(cashTotals.todayNema)} nema</span>
                  )}
                </p>
              </div>
            )}
            {totalWaiting > 0 && (
              <div>
                <p className="text-lg text-pos">{formatTRY(totalWaiting)}</p>
                <p className="text-xs text-muted">
                  <Link to="/ipo" className="hover:text-ink">Halka arz iadesi</Link> · çekilmeyi bekliyor
                </p>
              </div>
            )}
            {blockedTotal > 0 && (
              <div>
                <p className="text-lg text-amber-600 dark:text-amber-400">{formatTRY(blockedTotal)}</p>
                <p className="text-xs text-muted">
                  <Link to="/ipo" className="hover:text-ink">Arzda bloke</Link> · dağıtım bekliyor
                </p>
              </div>
            )}
            <div className="text-xs text-muted">
              {live && (
                <p>
                  {live.priced}/{live.count} kalem güncel fiyatla değerlendi
                </p>
              )}
              <p>Fiyat tarihi: {latestDate ?? '—'}</p>
            </div>
          </div>
          {priceError && <p className="mt-2 text-xs text-neg">{priceError}</p>}
        </Card>
      )}

      {tradeSeries.length > 0 && (
        <Card
          title="Pozisyon Değeri (alım / satım)"
          actions={
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => setShowNetLine((v) => !v)}
            >
              {showNetLine ? 'Vergi sonrasını gizle' : 'Vergi sonrasını göster'}
            </button>
          }
        >
          <NetWorthChart
            data={tradeSeries.map((p) => ({
              date: p.date,
              deger: p.value,
              vergiSonrasi: p.netValue,
            }))}
            series={
              showNetLine
                ? [
                    { key: 'deger', label: 'Değer', color: '#22c55e' },
                    { key: 'vergiSonrasi', label: 'Vergi sonrası', color: '#f59e0b' },
                  ]
                : [{ key: 'deger', label: 'Değer', color: '#22c55e' }]
            }
          />
          {showNetLine && (
            <p className="mt-2 text-xs text-muted">
              Turuncu çizgi, o gün satılsaydı fonlardan %{(DEFAULT_TAX_RATE * 100).toFixed(1).replace('.', ',')}{' '}
              stopaj kesildikten sonra cebe kalacak tutarı gösterir — hisselerden stopaj kesilmez.
              Noktalar işlem tarihlerinden geçer; ara günler için geçmiş fiyat tutulmuyor.
            </p>
          )}
        </Card>
      )}

      {fundProfit.length > 0 && (
        <Card
          title="Fon - Hisse Kâr / Zarar"
          actions={
            <span
              className={`num text-sm font-semibold ${
                fundProfitTotal >= 0 ? 'text-pos' : 'text-neg'
              }`}
            >
              Toplam {formatTRY(fundProfitTotal)}
            </span>
          }
        >
          <AccountBar data={fundProfitShown} />
          {showFundDetail && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className="th">Sembol</th>
                    <th className="th text-right">Adet</th>
                    <th className="th text-right">Güncel fiyat</th>
                    <th className="th text-right">Değer</th>
                    <th className="th text-right">Maliyet</th>
                    <th className="th text-right">Kâr / Zarar</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings
                    .filter((h) => h.quantity > 0)
                    .map((h) => (
                      <tr key={h.symbol} className="hover:bg-surface2/50">
                        <td className="td font-medium">
                          {h.symbol}
                          <span className="ml-2 text-xs text-muted">{h.kind}</span>
                        </td>
                        <td className="td text-right num">{formatNumber(h.quantity, 4)}</td>
                        <td className="td text-right num text-muted">
                          {h.price != null ? formatNumber(h.price, 4) : '—'}
                        </td>
                        <td className="td text-right num font-medium">
                          {formatTRY(h.value ?? h.costBasis)}
                          {h.price == null && (
                            <span className="ml-1 text-xs text-muted font-normal">maliyet</span>
                          )}
                        </td>
                        <td className="td text-right text-muted">
                          <div className="num">{formatTRY(h.costBasis)}</div>
                          <div className="text-xs num">ort. {formatNumber(h.avgCost, 4)}</div>
                        </td>
                        <td className="td text-right num">
                          {h.unrealized != null ? (
                            <span className={h.unrealized >= 0 ? 'text-pos' : 'text-neg'}>
                              {formatTRY(h.unrealized)}
                              {h.unrealizedPct != null && (
                                <span className="ml-1 text-xs">
                                  {formatPercent(h.unrealizedPct)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted">fiyat yok</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              Her kalemin gerçekleşen ve açık kârı toplanır; fonlarda stopaj düşülür, hisselerde
              vergi yoktur.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setShowFundDetail((v) => !v)}
              >
                {showFundDetail ? 'Detayı gizle' : 'Detay'}
              </button>
              {fundProfit.length > FUNDS_SHOWN && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setShowAllFunds((v) => !v)}
                >
                  {showAllFunds
                    ? 'Daha az göster'
                    : `Daha fazla göster (${fundProfit.length - FUNDS_SHOWN})`}
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Varlık Dağılımı">
          {posLoading ? <Spinner /> : byKind.length ? <AllocationPie data={byKind} /> : <Empty>Henüz kalem yok.</Empty>}
        </Card>
        <Card title="Hesap Bazlı Dağılım">
          {posLoading ? <Spinner /> : byAccount.length ? <AccountBar data={byAccount} /> : <Empty>Henüz kalem yok.</Empty>}
        </Card>
      </div>
    </div>
  )
}
