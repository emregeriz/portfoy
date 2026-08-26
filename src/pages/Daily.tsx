import { useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useDailyReturns } from '../hooks/useDailyReturns'
import DailyProfitChart, { type DailyPoint } from '../components/DailyProfitChart'
import StatCard from '../components/StatCard'
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatPercent, formatTRY } from '../lib/currency'
import { KIND_LABELS } from '../lib/calc'
import type { DailyItem, DailyPart, DailyRow } from '../lib/dailyReturn'

/**
 * Günlük Kâr — "hangi gün ne kazandım, o para nereden geldi".
 *
 * Grafikte her gün bir çubuk; bir güne tıklayınca o günün kalem kalem
 * dökümü ve o gün elde ne olduğu açılır. Rakamlar üst çubuktaki rozetle
 * aynı motordan (lib/dailyReturn) gelir.
 */

const RANGES = [
  { days: 30, label: '30 gün' },
  { days: 90, label: '90 gün' },
  { days: 365, label: '1 yıl' },
] as const

const PART_LABEL: Record<DailyPart, string> = {
  tut: 'elde tutuldu',
  satis: 'satıldı',
  alis: 'alındı',
  gelir: 'nakit gelir',
}

const PART_TONE: Record<DailyPart, string> = {
  tut: 'bg-surface2 text-muted border-border',
  satis: 'bg-accent/10 text-accent border-accent/30',
  alis: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  gelir: 'bg-pos/10 text-pos border-pos/30',
}

export default function Daily() {
  const { user } = useAuth()
  const [days, setDays] = useState<number>(90)
  const [mode, setMode] = useState<'gunluk' | 'birikimli'>('gunluk')
  const [picked, setPicked] = useState<string | null>(null)
  const { rows, byDate, priceDate, loading, error, reload } = useDailyReturns(user?.id, days)

  // Aralık değişince seçili gün listede kalmayabilir; son güne düşülür
  const selected: DailyRow | null = useMemo(() => {
    if (picked && byDate.has(picked)) return byDate.get(picked) as DailyRow
    return rows.length ? rows[rows.length - 1] : null
  }, [picked, byDate, rows])

  useEffect(() => {
    if (picked && !byDate.has(picked) && rows.length) setPicked(null)
  }, [picked, byDate, rows.length])

  const points: DailyPoint[] = useMemo(() => {
    let acc = 0
    return rows.map((r) => {
      acc += r.total
      return { date: r.date, total: r.total, cumulative: acc }
    })
  }, [rows])

  const stats = useMemo(() => {
    let sum = 0
    let win = 0
    let best: DailyRow | null = null
    let worst: DailyRow | null = null
    for (const r of rows) {
      sum += r.total
      if (r.total > 0) win++
      if (!best || r.total > best.total) best = r
      if (!worst || r.total < worst.total) worst = r
    }
    return { sum, win, best, worst, count: rows.length }
  }, [rows])

  if (loading && !rows.length) return <Spinner />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Günlük Kâr"
        subtitle="Her günün kazancı kalem kalem — hangi kâğıttan, hangi hesaptan, ne kadar"
        actions={
          <>
            <div className="flex items-center gap-1">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  type="button"
                  onClick={() => setDays(r.days)}
                  className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                    days === r.days
                      ? 'border-accent/40 bg-accent/10 text-accent font-medium'
                      : 'border-border text-muted hover:text-ink'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button className="btn-ghost text-xs" onClick={() => void reload()} disabled={loading}>
              {loading ? '…' : '↻'}
            </button>
          </>
        }
      />

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Dönem toplamı"
          value={stats.sum}
          tone={stats.sum > 0 ? 'pos' : stats.sum < 0 ? 'neg' : 'neutral'}
          hint={`${stats.count} hareketli gün · ${stats.win} gün kârda`}
        />
        <StatCard
          title="En iyi gün"
          value={stats.best?.total ?? 0}
          tone="pos"
          hint={
            stats.best ? format(parseISO(stats.best.date), 'd MMMM yyyy', { locale: tr }) : '—'
          }
        />
        <StatCard
          title="En kötü gün"
          value={stats.worst?.total ?? 0}
          tone={(stats.worst?.total ?? 0) < 0 ? 'neg' : 'neutral'}
          hint={
            stats.worst ? format(parseISO(stats.worst.date), 'd MMMM yyyy', { locale: tr }) : '—'
          }
        />
        <StatCard
          title="Günlük ortalama"
          value={stats.count ? stats.sum / stats.count : 0}
          tone={stats.sum > 0 ? 'pos' : stats.sum < 0 ? 'neg' : 'neutral'}
          hint={
            priceDate
              ? `Son fiyat: ${format(parseISO(priceDate), 'd MMMM', { locale: tr })}`
              : 'Fiyat geçmişi yok'
          }
        />
      </div>

      <Card
        title="Günlük kâr"
        actions={
          <div className="flex items-center gap-1">
            {(['gunluk', 'birikimli'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                  mode === m
                    ? 'border-accent/40 bg-accent/10 text-accent font-medium'
                    : 'border-border text-muted hover:text-ink'
                }`}
              >
                {m === 'gunluk' ? 'Günlük' : 'Birikimli'}
              </button>
            ))}
          </div>
        }
      >
        <DailyProfitChart
          data={points}
          selected={selected?.date ?? null}
          onSelect={setPicked}
          mode={mode}
        />
        <p className="mt-2 text-xs text-muted">
          Bir güne tıkla, o günün dökümü aşağıda açılsın. Yalnızca hareket olan günler çizilir.
        </p>
      </Card>

      {!selected ? (
        <Card>
          <Empty>Bu aralıkta hesaplanacak bir gün yok.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <DayBreakdown row={selected} />
          </div>
          <div className="lg:col-span-2">
            <DayHoldings row={selected} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Seçili günün kalem kalem dökümü */
function DayBreakdown({ row }: { row: DailyRow }) {
  const title = format(parseISO(row.date), 'd MMMM yyyy EEEE', { locale: tr })
  const tone = row.total > 0 ? 'text-pos' : row.total < 0 ? 'text-neg' : 'text-muted'

  return (
    <Card
      title={title}
      actions={
        <span className={`num text-lg font-semibold ${tone}`}>
          {row.total >= 0 ? '+' : '−'}
          {formatTRY(Math.abs(row.total))}
          {row.pct !== null && (
            <span className="text-muted text-xs font-normal"> ({formatPercent(row.pct)})</span>
          )}
        </span>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        <Mini label="Fon & hisse" value={row.priceDelta} />
        <Mini label={`Halka arz${row.ipoLots ? ` (${formatNumber(row.ipoLots, 0)} lot)` : ''}`} value={row.ipoDelta} />
        <Mini label="Nema" value={row.nema} />
        <Mini label="Temettü" value={row.dividend} />
      </div>

      {!row.items.length ? (
        <Empty>O gün ölçülebilir bir hareket olmadı.</Empty>
      ) : (
        <div className="overflow-x-auto -mx-4">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr>
                <th className="th">Kalem</th>
                <th className="th">Ne oldu</th>
                <th className="th text-right">Adet</th>
                <th className="th text-right">Fiyat</th>
                <th className="th text-right">Kâr / Zarar</th>
              </tr>
            </thead>
            <tbody>
              {row.items.map((it) => (
                <ItemRow key={it.key} item={it} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-muted">
        Satılan pay, gün sonu fiyatından değil <strong>gerçekleşen satış fiyatından</strong>{' '}
        ölçülür: kazanç = satılan lot × (satış fiyatı − önceki kapanış). Elde kalan pay önceki
        kapanıştan o günün kapanışına, o gün alınan pay kendi alış fiyatından ölçülür.
        {row.unmeasured > 0 && ` ${row.unmeasured} kalem ölçülemedi — önceki gün fiyatı yok.`}
        {!row.hasPrices && ' O gün borsa fiyatı yayınlanmadı; yalnızca gerçekleşen hareketler sayıldı.'}
      </p>
    </Card>
  )
}

function ItemRow({ item }: { item: DailyItem }) {
  const label =
    item.source === 'nema'
      ? 'Nema geliri'
      : item.source === 'temettu'
        ? `${item.symbol} temettü`
        : item.symbol

  return (
    <tr>
      <td className="td">
        <div className="font-medium text-ink">
          {label}
          {item.source === 'ipo' && <span className="ml-1 text-xs text-muted">arz</span>}
        </div>
        <div className="text-xs text-muted">
          {item.account ?? (item.source === 'portfoy' ? KIND_LABELS[item.kind] : '')}
        </div>
      </td>
      <td className="td">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${PART_TONE[item.part]}`}
        >
          {item.sameDay ? 'gün içi al-sat' : PART_LABEL[item.part]}
        </span>
      </td>
      <td className="td text-right num">{item.qty > 0 ? formatNumber(item.qty, 4) : '—'}</td>
      <td className="td text-right num text-xs">
        {item.from != null && item.to != null ? (
          <>
            <span className="text-muted">{formatNumber(item.from)}</span>
            <span className="text-muted"> → </span>
            <span className="text-ink">{formatNumber(item.to)}</span>
            <div className="text-[11px] text-muted">
              {item.sameDay
                ? 'alış → satış'
                : item.part === 'satis'
                  ? item.vsIpoPrice
                    ? 'arz fiyatı → satış'
                    : 'önceki kapanış → satış'
                  : item.part === 'alis'
                    ? 'alış → kapanış'
                    : item.vsIpoPrice
                      ? 'arz fiyatı → kapanış'
                      : 'önceki kapanış → kapanış'}
            </div>
          </>
        ) : (
          '—'
        )}
      </td>
      <td className={`td text-right num font-medium ${item.delta >= 0 ? 'text-pos' : 'text-neg'}`}>
        {item.delta >= 0 ? '+' : '−'}
        {formatTRY(Math.abs(item.delta))}
        {item.pct !== null && (
          <div className="text-[11px] text-muted font-normal">{formatPercent(item.pct)}</div>
        )}
      </td>
    </tr>
  )
}

/** O günün sonunda elde ne vardı */
function DayHoldings({ row }: { row: DailyRow }) {
  return (
    <Card
      title="O gün elimde ne vardı"
      actions={<span className="num text-sm text-muted">{formatTRY(row.value)}</span>}
    >
      {!row.holdings.length ? (
        <Empty>O gün açık pozisyon yok.</Empty>
      ) : (
        <div className="overflow-x-auto -mx-4">
          <table className="w-full min-w-[380px]">
            <thead>
              <tr>
                <th className="th">Varlık</th>
                <th className="th text-right">Adet</th>
                <th className="th text-right">Değer</th>
                <th className="th text-right">O gün</th>
              </tr>
            </thead>
            <tbody>
              {row.holdings.map((h) => (
                <tr key={`${h.source}:${h.symbol}`}>
                  <td className="td">
                    <div className="font-medium text-ink">
                      {h.symbol}
                      {h.source === 'ipo' && <span className="ml-1 text-xs text-muted">arz</span>}
                    </div>
                    <div className="text-xs text-muted">
                      {KIND_LABELS[h.kind]}
                      {h.price != null && ` · ${formatNumber(h.price)}`}
                    </div>
                  </td>
                  <td className="td text-right num">{formatNumber(h.qty, 4)}</td>
                  <td className="td text-right num">{h.value != null ? formatTRY(h.value) : '—'}</td>
                  <td
                    className={`td text-right num ${
                      h.delta > 0 ? 'text-pos' : h.delta < 0 ? 'text-neg' : 'text-muted'
                    }`}
                  >
                    {h.delta === 0 ? '—' : `${h.delta > 0 ? '+' : '−'}${formatTRY(Math.abs(h.delta))}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Gün sonundaki pozisyonlar ve o güne kadarki son fiyatla değerleri. Nakit bakiyeler bu
        listede yok — burada yalnızca fiyatı olan pozisyonlar var.
      </p>
    </Card>
  )
}

function Mini({ label, value: raw }: { label: string; value: number }) {
  // Kuruşun altındaki artık "−₺0,00" diye görünmesin
  const value = Math.abs(raw) < 0.005 ? 0 : raw
  return (
    <div className="rounded-lg border border-border bg-surface2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div
        className={`num text-sm font-medium ${
          value > 0 ? 'text-pos' : value < 0 ? 'text-neg' : 'text-muted'
        }`}
      >
        {value > 0 ? '+' : value < 0 ? '−' : ''}
        {formatTRY(Math.abs(value))}
      </div>
    </div>
  )
}
