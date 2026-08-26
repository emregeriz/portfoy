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

export interface DailyPoint {
  date: string
  total: number
  /** O güne kadarki birikimli kâr */
  cumulative: number
}

interface Props {
  data: DailyPoint[]
  /** Seçili gün — çubuğu vurgulanır */
  selected: string | null
  onSelect: (date: string) => void
  mode: 'gunluk' | 'birikimli'
  height?: number
}

/**
 * Günlük kâr grafiği.
 *
 * "Günlük" modda her gün bir çubuk: kâr yeşil, zarar kırmızı. Çubuğa
 * tıklanınca o günün dökümü açılır. "Birikimli" mod aynı seriyi toplayarak
 * çizer — kârın zaman içinde nasıl biriktiğini gösterir.
 *
 * Yalnızca hareket olan günler çizilir; borsanın kapalı olduğu günler
 * grafikte yer kaplamaz.
 */
export default function DailyProfitChart({ data, selected, onSelect, mode, height = 280 }: Props) {
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
        <div className="text-xs text-muted mb-1">
          {format(parseISO(p.date), 'd MMMM yyyy EEEE', { locale: tr })}
        </div>
        <div className={`text-sm num font-medium ${v >= 0 ? 'text-pos' : 'text-neg'}`}>
          {v >= 0 ? '+' : '−'}
          {formatTRY(Math.abs(v))}
        </div>
        {mode === 'birikimli' && (
          <div className={`text-xs num ${p.total >= 0 ? 'text-pos' : 'text-neg'}`}>
            o gün {p.total >= 0 ? '+' : '−'}
            {formatTRY(Math.abs(p.total))}
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
        tickFormatter={(v) => format(parseISO(String(v)), 'd MMM', { locale: tr })}
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
          <Bar dataKey="total" name="Günlük kâr" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell
                key={d.date}
                cursor="pointer"
                fill={d.total >= 0 ? pos : neg}
                fillOpacity={selected && selected !== d.date ? 0.35 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      )}
    </ResponsiveContainer>
  )
}
