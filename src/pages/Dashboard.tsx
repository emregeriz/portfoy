import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useNetWorth, useSnapshots, usePositionsForSnapshots } from '../hooks/useSnapshots'
import { usePrices } from '../hooks/usePrices'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import NetWorthChart, { type ChartPoint } from '../components/NetWorthChart'
import AllocationPie from '../components/AllocationPie'
import AccountBar from '../components/AccountBar'
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import {
  allocationByAccount,
  allocationByKind,
  bucketSeries,
  change,
  limitByPeriod,
  sumSeriesByDate,
  PERIOD_LABELS,
  type Period,
} from '../lib/calc'
import { formatPercent, formatTRY } from '../lib/currency'

export default function Dashboard() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  const [period, setPeriod] = useState<Period>('aylik')

  const effectiveScope = scope || user?.id || ''
  const isTotal = effectiveScope === 'toplam'

  const { rows, loading, error } = useNetWorth(isTotal ? null : effectiveScope)
  const { snapshots } = useSnapshots(isTotal ? null : effectiveScope)

  const series = useMemo(() => {
    const base = isTotal ? sumSeriesByDate(rows) : rows
    return bucketSeries(limitByPeriod(base, period), period)
  }, [rows, period, isTotal])

  const chartData: ChartPoint[] = useMemo(
    () =>
      series.map((r) => ({
        date: r.snapshot_date,
        net: r.net_worth_try,
        varlik: r.total_assets_try,
      })),
    [series]
  )

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

  const byKind = useMemo(() => allocationByKind(positions), [positions])
  const byAccount = useMemo(() => allocationByAccount(positions), [positions])

  const netChange = change(last?.net_worth_try ?? 0, prev?.net_worth_try)

  const { byAssetId, latestDate, refreshing, refresh, error: priceError } = usePrices()

  /**
   * Son snapshot'taki adetler güncel fiyatlarla değerlenir.
   * Adedi veya fiyatı olmayan kalemler snapshot'taki tutarıyla sayılır.
   */
  const live = useMemo(() => {
    if (!positions.length) return null
    let total = 0
    let priced = 0
    for (const p of positions) {
      const lp = p.asset_id ? byAssetId.get(p.asset_id) : undefined
      const qty = Number(p.quantity ?? 0)
      if (lp && qty > 0) {
        total += qty * Number(lp.price)
        priced++
      } else {
        total += Number(p.amount_try ?? 0)
      }
    }
    return { total, priced, count: positions.length }
  }, [positions, byAssetId])

  const liveNet = live ? live.total - (last?.total_liabilities_try ?? 0) : null
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
          <Link to="/snapshot/new" className="btn-primary">
            + Yeni Giriş
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
        <div className="ml-auto inline-flex rounded-lg border border-border bg-surface p-1 gap-1">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-md text-sm ${
                period === p ? 'bg-surface2 text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Toplam Varlık" value={last?.total_assets_try ?? 0} />
        <StatCard
          title="Toplam Borç"
          value={last?.total_liabilities_try ?? 0}
          tone={(last?.total_liabilities_try ?? 0) > 0 ? 'neg' : 'neutral'}
        />
        <StatCard
          title="Net Değer"
          value={last?.net_worth_try ?? 0}
          change={netChange}
          tone={(last?.net_worth_try ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <StatCard
          title="Kayıt Sayısı"
          value={String(raw.length)}
          hint={prev ? `Önceki: ${formatTRY(prev.net_worth_try)}` : 'Karşılaştırma için 2. kayıt gerekli'}
        />
      </div>

      {live && live.priced > 0 && (
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
              <p className="text-2xl font-semibold text-slate-100">{formatTRY(liveNet ?? 0)}</p>
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
              <p className="text-lg text-slate-200">{formatTRY(live.total)}</p>
              <p className="text-xs text-muted">Toplam varlık</p>
            </div>
            <div className="text-xs text-muted">
              <p>
                {live.priced}/{live.count} kalem güncel fiyatla değerlendi
              </p>
              <p>Fiyat tarihi: {latestDate ?? '—'}</p>
            </div>
          </div>
          {priceError && <p className="mt-2 text-xs text-rose-400">{priceError}</p>}
        </Card>
      )}

      <Card title="Net Değer Zaman Serisi">
        {loading ? <Spinner /> : (
          <NetWorthChart
            data={chartData}
            series={[
              { key: 'net', label: 'Net Değer', color: '#4f8cff' },
              { key: 'varlik', label: 'Toplam Varlık', color: '#22c55e' },
            ]}
          />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Varlık Dağılımı">
          {posLoading ? <Spinner /> : byKind.length ? <AllocationPie data={byKind} /> : <Empty>Son kayıtta kalem yok.</Empty>}
        </Card>
        <Card title="Hesap Bazlı Dağılım">
          {posLoading ? <Spinner /> : byAccount.length ? <AccountBar data={byAccount} /> : <Empty>Son kayıtta kalem yok.</Empty>}
        </Card>
      </div>
    </div>
  )
}
