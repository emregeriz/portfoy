import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { formatCompactTRY, formatTRY } from '../lib/currency'
import { useChartColors } from '../hooks/useTheme'

export interface SeriesDef {
  key: string
  label: string
  color: string
}

export interface ChartPoint {
  date: string
  [key: string]: string | number | null
}

interface Props {
  data: ChartPoint[]
  series: SeriesDef[]
  height?: number
  type?: 'area' | 'line'
}

function TooltipBox({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-surface2 px-3 py-2 shadow-xl">
      <div className="text-xs text-muted mb-1">
        {format(parseISO(String(label)), 'd MMMM yyyy', { locale: tr })}
      </div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}</span>
          <span className="ml-auto num font-medium">{formatTRY(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function NetWorthChart({ data, series, height = 300, type = 'area' }: Props) {
  const cc = useChartColors()
  const axisStyle = { fill: cc.tick, fontSize: 11 }

  if (!data.length) {
    return (
      <div className="h-[300px] grid place-items-center text-sm text-muted">
        Grafik için henüz veri yok.
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={cc.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tick={axisStyle}
          tickLine={false}
          axisLine={{ stroke: cc.grid }}
          tickFormatter={(v) => format(parseISO(String(v)), 'd MMM', { locale: tr })}
          minTickGap={24}
        />
        <YAxis
          tick={axisStyle}
          tickLine={false}
          axisLine={false}
          width={70}
          tickFormatter={(v) => formatCompactTRY(Number(v))}
        />
        <Tooltip content={<TooltipBox />} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: cc.legend }} />}
        {series.map((s) =>
          type === 'area' ? (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#grad-${s.key})`}
              connectNulls
              dot={false}
              activeDot={{ r: 4 }}
            />
          ) : (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              connectNulls
              dot={false}
            />
          )
        )}
      </AreaChart>
    </ResponsiveContainer>
  )
}
