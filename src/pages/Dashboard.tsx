import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useNetWorth, useSnapshots, usePositionsForSnapshots } from '../hooks/useSnapshots'
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
import { formatTRY } from '../lib/currency'

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
                period === p ? 'bg-surface2 text-slate-100' : 'text-muted hover:text-slate-200'
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
