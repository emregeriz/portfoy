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
import {
  aggregateDailyRows,
  type DailyItem,
  type DailyPart,
  type DailyRow,
  type DailySource,
  type Grain,
  type PeriodRow,
} from '../lib/dailyReturn'

/**
 * Günlük Kâr — "hangi dönemde ne kazandım, o para nereden geldi".
 *
 * Grafikte her çubuk bir dönem: gün, hafta, ay ya da yıl. Bir çubuğa
 * tıklayınca o dönemin kalem kalem dökümü açılır; kovalanmış görünümde
 * dönemin günleri de listelenir, birine tıklayınca o günün tam dökümü
 * gelir. Rakamlar üst çubuktaki rozetle aynı motordan (lib/dailyReturn).
 */

const GRAINS: { key: Grain; label: string }[] = [
  { key: 'gun', label: 'Günlük' },
  { key: 'hafta', label: 'Haftalık' },
  { key: 'ay', label: 'Aylık' },
  { key: 'yil', label: 'Yıllık' },
]

/** Çözünürlüğe göre anlamlı aralıklar — yıllık grafikte 30 günün anlamı yok */
const RANGES: Record<Grain, { days: number; label: string }[]> = {
  gun: [
    { days: 30, label: '30 gün' },
    { days: 90, label: '90 gün' },
    { days: 365, label: '1 yıl' },
  ],
  hafta: [
    { days: 90, label: '90 gün' },
    { days: 365, label: '1 yıl' },
    { days: 1095, label: '3 yıl' },
  ],
  ay: [
    { days: 365, label: '1 yıl' },
    { days: 1095, label: '3 yıl' },
    { days: 3650, label: 'Tümü' },
  ],
  yil: [
    { days: 1095, label: '3 yıl' },
    { days: 3650, label: 'Tümü' },
  ],
}

const GRAIN_NOUN: Record<Grain, string> = { gun: 'gün', hafta: 'hafta', ay: 'ay', yil: 'yıl' }
/** "o günün / o haftanın …" — Türkçe ek elle yazılıyor */
const GRAIN_POSS: Record<Grain, string> = {
  gun: 'o günün',
  hafta: 'o haftanın',
  ay: 'o ayın',
  yil: 'o yılın',
}
const AVG_TITLE: Record<Grain, string> = {
  gun: 'Günlük ortalama',
  hafta: 'Haftalık ortalama',
  ay: 'Aylık ortalama',
  yil: 'Yıllık ortalama',
}

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

/** Dönemin başlığı — haftada aralık, ayda ay adı, yılda yıl */
function periodLabel(row: PeriodRow): string {
  const start = parseISO(row.start)
  if (row.grain === 'yil') return format(start, 'yyyy', { locale: tr })
  if (row.grain === 'ay') return format(start, 'MMMM yyyy', { locale: tr })
  if (row.grain === 'hafta') {
    return `${format(start, 'd MMM', { locale: tr })} – ${format(parseISO(row.end), 'd MMM yyyy', {
      locale: tr,
    })}`
  }
  return format(start, 'd MMMM yyyy', { locale: tr })
}

function itemName(source: DailySource, symbol: string): string {
  if (source === 'nema') return 'Nema geliri'
  if (source === 'temettu') return `${symbol} temettü`
  return symbol
}

export default function Daily() {
  const { user } = useAuth()
  const [grain, setGrain] = useState<Grain>('gun')
  const [days, setDays] = useState<number>(90)
  const [mode, setMode] = useState<'gunluk' | 'birikimli'>('gunluk')
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [pickedDay, setPickedDay] = useState<string | null>(null)
  const { rows, priceDate, loading, error, reload } = useDailyReturns(user?.id, days)

  const periods = useMemo(() => aggregateDailyRows(rows, grain), [rows, grain])
  const byKey = useMemo(() => new Map(periods.map((p) => [p.key, p] as const)), [periods])

  // Aralık ya da çözünürlük değişince seçili kova listede kalmayabilir;
  // sonuncuya düşülür
  const selected: PeriodRow | null = useMemo(() => {
    if (pickedKey && byKey.has(pickedKey)) return byKey.get(pickedKey) as PeriodRow
    return periods.length ? periods[periods.length - 1] : null
  }, [pickedKey, byKey, periods])

  useEffect(() => {
    if (pickedKey && !byKey.has(pickedKey) && periods.length) setPickedKey(null)
  }, [pickedKey, byKey, periods.length])

  // Günlük çözünürlükte kova zaten tek gün; kovalanmış görünümde gün
  // listesinden seçilir. Kova değişince seçim kendiliğinden düşer.
  const day: DailyRow | null =
    grain === 'gun'
      ? (selected?.days[0] ?? null)
      : (selected?.days.find((d) => d.date === pickedDay) ?? null)

  const changeGrain = (g: Grain) => {
    setGrain(g)
    setPickedKey(null)
    setPickedDay(null)
    if (!RANGES[g].some((r) => r.days === days)) setDays(RANGES[g][0].days)
  }

  // Çubuğun boyu `chartTotal` — toplu kayıt gününde yalnızca fon kârı.
  // Birikimli çizgi ve alttaki döküm gerçek kârı sayar, kimse kaybolmaz.
  const points: DailyPoint[] = useMemo(() => {
    let acc = 0
    return periods.map((p) => {
      acc += p.total
      return {
        date: p.key,
        end: p.end,
        total: p.chartTotal,
        real: p.total,
        trimmed: p.bulkEntry,
        cumulative: acc,
        count: p.days.length,
      }
    })
  }, [periods])

  const stats = useMemo(() => {
    let sum = 0
    let win = 0
    let best: PeriodRow | null = null
    let worst: PeriodRow | null = null
    for (const p of periods) {
      sum += p.total
      if (p.total > 0) win++
      if (!best || p.total > best.total) best = p
      if (!worst || p.total < worst.total) worst = p
    }
    return { sum, win, best, worst, count: periods.length }
  }, [periods])

  if (loading && !rows.length) return <Spinner />

  const noun = GRAIN_NOUN[grain]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Günlük Kâr"
        subtitle="Her dönemin kazancı kalem kalem — hangi kâğıttan, hangi hesaptan, ne kadar"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Segmented value={grain} options={GRAINS} onChange={(k) => changeGrain(k as Grain)} />
            <Segmented
              value={String(days)}
              options={RANGES[grain].map((r) => ({ key: String(r.days), label: r.label }))}
              onChange={(k) => setDays(Number(k))}
            />
            <button className="btn-ghost text-xs" onClick={() => void reload()} disabled={loading}>
              {loading ? '…' : '↻'}
            </button>
          </div>
        }
      />

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Dönem toplamı"
          value={stats.sum}
          tone={stats.sum > 0 ? 'pos' : stats.sum < 0 ? 'neg' : 'neutral'}
          hint={`${stats.count} hareketli ${noun} · ${stats.win} ${noun} kârda`}
        />
        <StatCard
          title={`En iyi ${noun}`}
          value={stats.best?.total ?? 0}
          tone="pos"
          hint={stats.best ? periodLabel(stats.best) : '—'}
        />
        <StatCard
          title={`En kötü ${noun}`}
          value={stats.worst?.total ?? 0}
          tone={(stats.worst?.total ?? 0) < 0 ? 'neg' : 'neutral'}
          hint={stats.worst ? periodLabel(stats.worst) : '—'}
        />
        <StatCard
          title={AVG_TITLE[grain]}
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
        title={`${GRAINS.find((g) => g.key === grain)?.label} kâr`}
        actions={
          <Segmented
            value={mode}
            options={[
              { key: 'gunluk', label: grain === 'gun' ? 'Günlük' : 'Dönemlik' },
              { key: 'birikimli', label: 'Birikimli' },
            ]}
            onChange={(k) => setMode(k as 'gunluk' | 'birikimli')}
          />
        }
      >
        <DailyProfitChart
          data={points}
          selected={selected?.key ?? null}
          onSelect={setPickedKey}
          mode={mode}
          grain={grain}
        />
        <p className="mt-2 text-xs text-muted">
          Bir çubuğa tıkla, {GRAIN_POSS[grain]} dökümü aşağıda açılsın. Yalnızca hareket olan
          günler sayılır.
          {mode === 'gunluk' && points.some((p) => p.trimmed) && (
            <>
              {' '}
              Geçmiş pozisyonların toplu girildiği günde (kesik çerçeveli çubuk) yalnızca o günün
              fon kârı çizilir — hisse tarafındaki kâr aylara yayılmış birikim olduğu için çubuğu
              ölçeksiz büyütüyordu. Kârın tamamı aşağıdaki dökümde ve birikimli çizgide duruyor.
            </>
          )}
        </p>
      </Card>

      {!selected ? (
        <Card>
          <Empty>Bu aralıkta hesaplanacak bir gün yok.</Empty>
        </Card>
      ) : grain === 'gun' ? (
        day && (
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <DayBreakdown row={day} />
            </div>
            <div className="lg:col-span-2">
              <DayHoldings row={day} />
            </div>
          </div>
        )
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <PeriodBreakdown row={selected} />
            </div>
            <div className="lg:col-span-2">
              <PeriodDays
                row={selected}
                picked={day?.date ?? null}
                onPick={(d) => setPickedDay((cur) => (cur === d ? null : d))}
              />
            </div>
          </div>
          {day && (
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <DayBreakdown row={day} />
              </div>
              <div className="lg:col-span-2">
                <DayHoldings row={day} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Küçük seçim düğmeleri — çözünürlük, aralık ve grafik modu aynı görünümü paylaşır */
function Segmented({
  value,
  options,
  onChange,
}: {
  value: string
  options: { key: string; label: string }[]
  onChange: (key: string) => void
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
            value === o.key
              ? 'border-accent/40 bg-accent/10 text-accent font-medium'
              : 'border-border text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Seçili haftanın / ayın / yılın toplu dökümü */
function PeriodBreakdown({ row }: { row: PeriodRow }) {
  const tone = row.total > 0 ? 'text-pos' : row.total < 0 ? 'text-neg' : 'text-muted'

  return (
    <Card
      title={periodLabel(row)}
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
        <Mini label="Halka arz" value={row.ipoDelta} />
        <Mini label="Nema" value={row.nema} />
        <Mini label="Temettü" value={row.dividend} />
      </div>

      {row.bulkEntry && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Bu dönemde geçmiş pozisyonların toplu girildiği bir gün var: aylara yayılmış kâr tek güne
          yığıldığı için grafikteki çubuk o günün yalnızca fon kârını sayıyor. Buradaki toplam
          olduğu gibi duruyor.
        </div>
      )}

      {!row.items.length ? (
        <Empty>Bu dönemde ölçülebilir bir hareket olmadı.</Empty>
      ) : (
        <div className="overflow-x-auto -mx-4">
          <table className="w-full min-w-[420px]">
            <thead>
              <tr>
                <th className="th">Kalem</th>
                <th className="th">Tür</th>
                <th className="th text-right">Hareket</th>
                <th className="th text-right">Kâr / Zarar</th>
              </tr>
            </thead>
            <tbody>
              {row.items.map((it) => (
                <tr key={it.key}>
                  <td className="td">
                    <div className="font-medium text-ink">{itemName(it.source, it.symbol)}</div>
                  </td>
                  <td className="td text-xs text-muted">
                    {it.source === 'ipo' ? 'halka arz' : KIND_LABELS[it.kind]}
                  </td>
                  <td className="td text-right num text-xs text-muted">{it.dayCount} gün</td>
                  <td
                    className={`td text-right num font-medium ${
                      it.delta >= 0 ? 'text-pos' : 'text-neg'
                    }`}
                  >
                    {it.delta >= 0 ? '+' : '−'}
                    {formatTRY(Math.abs(it.delta))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-muted">
        {row.days.length} hareketli gün · {row.winDays} gün kârda
        {row.best && (
          <>
            {' '}
            · en iyi gün {format(parseISO(row.best.date), 'd MMM', { locale: tr })} (
            <span className={row.best.total >= 0 ? 'text-pos' : 'text-neg'}>
              {row.best.total >= 0 ? '+' : '−'}
              {formatTRY(Math.abs(row.best.total))}
            </span>
            )
          </>
        )}
        {row.worst && row.worst.date !== row.best?.date && (
          <>
            {' '}
            · en kötü gün {format(parseISO(row.worst.date), 'd MMM', { locale: tr })} (
            <span className={row.worst.total >= 0 ? 'text-pos' : 'text-neg'}>
              {row.worst.total >= 0 ? '+' : '−'}
              {formatTRY(Math.abs(row.worst.total))}
            </span>
            )
          </>
        )}
        {row.unmeasured > 0 && ` · ${row.unmeasured} kalem ölçülemedi — önceki gün fiyatı yok.`}
      </p>
    </Card>
  )
}

/** Dönemin günleri — birine tıklayınca o günün tam dökümü açılır */
function PeriodDays({
  row,
  picked,
  onPick,
}: {
  row: PeriodRow
  picked: string | null
  onPick: (date: string) => void
}) {
  return (
    <Card
      title="Dönemin günleri"
      actions={<span className="num text-sm text-muted">{row.days.length} gün</span>}
    >
      <div className="overflow-x-auto -mx-4">
        <table className="w-full min-w-[280px]">
          <thead>
            <tr>
              <th className="th">Gün</th>
              <th className="th text-right">Kâr / Zarar</th>
            </tr>
          </thead>
          <tbody>
            {row.days.map((d) => (
              <tr
                key={d.date}
                onClick={() => onPick(d.date)}
                className={`cursor-pointer hover:bg-surface2 ${
                  picked === d.date ? 'bg-accent/10' : ''
                }`}
              >
                <td className="td">
                  <div className="font-medium text-ink">
                    {format(parseISO(d.date), 'd MMMM EEEE', { locale: tr })}
                  </div>
                  {d.items.length > 0 && (
                    <div className="text-xs text-muted">{d.items.length} kalem</div>
                  )}
                </td>
                <td
                  className={`td text-right num font-medium ${
                    d.total > 0 ? 'text-pos' : d.total < 0 ? 'text-neg' : 'text-muted'
                  }`}
                >
                  {d.total >= 0 ? '+' : '−'}
                  {formatTRY(Math.abs(d.total))}
                  {d.pct !== null && (
                    <div className="text-[11px] text-muted font-normal">{formatPercent(d.pct)}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Bir güne tıkla, o günün kalem kalem dökümü ve elindekiler aşağıda açılsın.
      </p>
    </Card>
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

      {row.bulkEntry && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Bu gün geçmiş pozisyonlar toplu girildi: aylara yayılmış kâr tek güne yığıldığı için
          aşağıdaki “alındı” kalemleri kendi alış fiyatından ölçülüyor. Gün toplamı olduğu gibi
          duruyor, grafikteki çubuk yalnızca o günün fon kârını{' '}
          <span className="num font-medium">
            {row.chartTotal >= 0 ? '+' : '−'}
            {formatTRY(Math.abs(row.chartTotal))}
          </span>{' '}
          gösteriyor.
        </div>
      )}

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
  const label = itemName(item.source, item.symbol)

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
