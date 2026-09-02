import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { formatCompactTRY, formatTRY } from '../lib/currency'
import { useChartColors, useTheme } from '../hooks/useTheme'
import type { Grain } from '../lib/dailyReturn'

export interface DailyPoint {
  /** Kovanın ilk günü — seçim anahtarı ve x ekseni */
  date: string
  /** Kovanın son takvim günü — haftalık başlıkta aralık yazmak için */
  end: string
  /** Çubuğun boyu — toplu kayıt gününde yalnızca fon kârı */
  total: number
  /** Dönemin gerçek kârı; çubuk kırpıldıysa `total`den farklıdır */
  real: number
  /** Çubuk kırpıldı mı — geçmiş pozisyonların toplu girildiği gün */
  trimmed: boolean
  /** O döneme kadarki birikimli kâr — gerçek kârların toplamı */
  cumulative: number
  /** Kovadaki hareketli gün sayısı */
  count: number
}

interface Props {
  data: DailyPoint[]
  /** Seçili kova — çubuğu vurgulanır */
  selected: string | null
  onSelect: (key: string) => void
  mode: 'gunluk' | 'birikimli'
  /** Bir çubuk kaç günü topluyor */
  grain?: Grain
  height?: number
}

/** Eksendeki kısa etiket */
function tickLabel(date: string, grain: Grain): string {
  const d = parseISO(date)
  if (grain === 'yil') return format(d, 'yyyy', { locale: tr })
  if (grain === 'ay') return format(d, 'MMM yy', { locale: tr })
  return format(d, 'd MMM', { locale: tr })
}

/** İpucundaki uzun başlık */
function pointTitle(p: DailyPoint, grain: Grain): string {
  const start = parseISO(p.date)
  if (grain === 'yil') return format(start, 'yyyy', { locale: tr })
  if (grain === 'ay') return format(start, 'MMMM yyyy', { locale: tr })
  if (grain === 'hafta') {
    return `${format(start, 'd MMM', { locale: tr })} – ${format(parseISO(p.end), 'd MMM yyyy', {
      locale: tr,
    })}`
  }
  return format(start, 'd MMMM yyyy EEEE', { locale: tr })
}

/**
 * Kâr grafiği.
 *
 * "Günlük" modda her kova bir çubuk: kâr yeşil, zarar kırmızı. Çubuğa
 * tıklanınca o dönemin dökümü açılır. "Birikimli" mod aynı seriyi toplayarak
 * çizer — kârın zaman içinde nasıl biriktiğini gösterir.
 *
 * Çözünürlük `grain` ile seçilir: gün / hafta / ay / yıl. Yalnızca hareket
 * olan günler sayılır; borsanın kapalı olduğu günler grafikte yer kaplamaz.
 *
 * Geçmiş pozisyonların toplu girildiği günde çubuk kırpılır (`trimmed`):
 * boyu yalnızca o günün fon kârı kadardır, çünkü hisse tarafındaki kâr
 * aslında aylara yayılmış birikimdir. Gerçek kâr kaybolmaz — ipucunda yazar,
 * birikimli çizgide ve dökümde tam sayılır.
 */
export default function DailyProfitChart({
  data,
  selected,
  onSelect,
  mode,
  grain = 'gun',
  height = 280,
}: Props) {
  const cc = useChartColors()
  const { theme } = useTheme()
  const axisStyle = { fill: cc.tick, fontSize: 11 }
  const pos = theme === 'dark' ? '#22c55e' : '#16a34a'
  const neg = theme === 'dark' ? '#ef4444' : '#dc2626'

  if (!data.length) {
    return (
      <div className="h-[280px] grid place-items-center text-sm text-muted">
        Bu aralıkta hareket yok.
      </div>
    )
  }

  // recharts kendi tooltip tipini dışarı vermiyor — NetWorthChart ile aynı yol
  const tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const p = payload[0].payload as DailyPoint
    const v = mode === 'birikimli' ? p.cumulative : p.total
    return (
      <div className="rounded-lg border border-border bg-surface2 px-3 py-2 shadow-xl">
        <div className="text-xs text-muted mb-1">{pointTitle(p, grain)}</div>
        <div className={`text-sm num font-medium ${v >= 0 ? 'text-pos' : 'text-neg'}`}>
          {v >= 0 ? '+' : '−'}
          {formatTRY(Math.abs(v))}
        </div>
        {mode === 'birikimli' && (
          <div className={`text-xs num ${p.real >= 0 ? 'text-pos' : 'text-neg'}`}>
            bu dönem {p.real >= 0 ? '+' : '−'}
            {formatTRY(Math.abs(p.real))}
          </div>
        )}
        {grain !== 'gun' && (
          <div className="text-[11px] text-muted">{p.count} hareketli gün</div>
        )}
        {p.trimmed && mode === 'gunluk' && (
          <div className="mt-1 pt-1 border-t border-border text-[11px] text-muted">
            grafikte yalnızca fon kârı — gerçek kâr{' '}
            <span className={`num ${p.real >= 0 ? 'text-pos' : 'text-neg'}`}>
              {p.real >= 0 ? '+' : '−'}
              {formatTRY(Math.abs(p.real))}
            </span>
            <div>geçmiş pozisyonlar tek günde toplu girilmiş</div>
          </div>
        )}
      </div>
    )
  }

  const axes = (
    <>
      <CartesianGrid stroke={cc.grid} strokeDasharray="3 3" vertical={false} />
      <XAxis
        dataKey="date"
        tick={axisStyle}
        tickLine={false}
        axisLine={{ stroke: cc.grid }}
        tickFormatter={(v) => tickLabel(String(v), grain)}
        minTickGap={20}
      />
      <YAxis
        tick={axisStyle}
        tickLine={false}
        axisLine={false}
        width={70}
        tickFormatter={(v) => formatCompactTRY(Number(v))}
      />
      <Tooltip content={tip} cursor={{ fill: cc.cursor }} />
      <ReferenceLine y={0} stroke={cc.grid} />
    </>
  )

  return (
    <ResponsiveContainer width="100%" height={height}>
      {mode === 'birikimli' ? (
        <AreaChart
          data={data}
          margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
          onClick={(e) => {
            if (e?.activeLabel != null) onSelect(String(e.activeLabel))
          }}
        >
          <defs>
            <linearGradient id="grad-daily" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={pos} stopOpacity={0.35} />
              <stop offset="100%" stopColor={pos} stopOpacity={0} />
            </linearGradient>
          </defs>
          {axes}
          <Area
            type="monotone"
            dataKey="cumulative"
            name="Birikimli kâr"
            stroke={pos}
            strokeWidth={2}
            fill="url(#grad-daily)"
            dot={false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      ) : (
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
          onClick={(e) => {
            if (e?.activeLabel != null) onSelect(String(e.activeLabel))
          }}
        >
          {axes}
          <Bar dataKey="total" name="Kâr" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell
                key={d.date}
                cursor="pointer"
                fill={d.total >= 0 ? pos : neg}
                // Kırpılmış çubuk kesik çerçeveyle işaretlenir — o günün
                // tamamı değil, yalnızca fon kârı çizildiği belli olsun
                fillOpacity={(selected && selected !== d.date ? 0.35 : 1) * (d.trimmed ? 0.5 : 1)}
                stroke={d.trimmed ? (d.total >= 0 ? pos : neg) : undefined}
                strokeDasharray={d.trimmed ? '2 2' : undefined}
              />
            ))}
          </Bar>
        </BarChart>
      )}
    </ResponsiveContainer>
  )
}
