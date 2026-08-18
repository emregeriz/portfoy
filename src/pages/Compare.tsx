import { useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useNetWorth } from '../hooks/useSnapshots'
import NetWorthChart, { type ChartPoint, type SeriesDef } from '../components/NetWorthChart'
import StatCard from '../components/StatCard'
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { bucketSeries, limitByPeriod, PERIOD_LABELS, type Period } from '../lib/calc'

export default function Compare() {
  const { profiles, user } = useAuth()
  const [period, setPeriod] = useState<Period>('aylik')
  const { rows, loading, error } = useNetWorth(null)

  const series: SeriesDef[] = useMemo(
    () =>
      profiles.map((p) => ({
        key: p.id,
        label: p.id === user?.id ? `${p.display_name} (sen)` : p.display_name,
        color: p.color ?? '#4f8cff',
      })),
    [profiles, user?.id]
  )

  const data: ChartPoint[] = useMemo(() => {
    const byDate = new Map<string, ChartPoint>()
    for (const p of profiles) {
      const own = rows.filter((r) => r.user_id === p.id)
      const bucketed = bucketSeries(limitByPeriod(own, period), period)
      for (const r of bucketed) {
        const point = byDate.get(r.snapshot_date) ?? { date: r.snapshot_date }
        point[p.id] = r.net_worth_try
        byDate.set(r.snapshot_date, point)
      }
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }, [rows, profiles, period])

  const latest = useMemo(
    () =>
      profiles.map((p) => {
        const own = rows.filter((r) => r.user_id === p.id)
        const last = own[own.length - 1]
        return { profile: p, value: last?.net_worth_try ?? 0 }
      }),
    [rows, profiles]
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Karşılaştırma"
        subtitle="İki portföyün net değer eğrisi yan yana."
        actions={
          <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1">
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
        }
      />

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {latest.map(({ profile, value }) => (
          <StatCard
            key={profile.id}
            title={profile.display_name}
            value={value}
            tone={value >= 0 ? 'pos' : 'neutral'}
          />
        ))}
      </div>

      <Card title="Net Değer Karşılaştırması">
        {loading ? (
          <Spinner />
        ) : profiles.length < 2 ? (
          <Empty>Karşılaştırma için en az iki profil gerekli.</Empty>
        ) : (
          <NetWorthChart data={data} series={series} type="line" height={340} />
        )}
      </Card>
    </div>
  )
}
