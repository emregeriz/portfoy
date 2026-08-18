import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { colorAt, type Slice } from '../lib/calc'
import { formatTRY } from '../lib/currency'

export default function AllocationPie({ data }: { data: Slice[] }) {
  const total = data.reduce((s, d) => s + d.value, 0)

  if (!data.length) {
    return <div className="h-[280px] grid place-items-center text-sm text-muted">Veri yok.</div>
  }

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <ResponsiveContainer width="100%" height={220} className="max-w-[240px]">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={55}
            outerRadius={90}
            paddingAngle={2}
            stroke="none"
          >
            {data.map((d, i) => (
              <Cell key={d.key} fill={colorAt(i)} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: '#1a2233',
              border: '1px solid #243047',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v: any, n: any) => [formatTRY(Number(v)), n]}
          />
        </PieChart>
      </ResponsiveContainer>

      <ul className="flex-1 w-full space-y-1.5">
        {data.map((d, i) => (
          <li key={d.key} className="flex items-center gap-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorAt(i) }} />
            <span className="text-slate-200 truncate">{d.label}</span>
            <span className="ml-auto num text-muted">
              {total ? ((d.value / total) * 100).toFixed(1).replace('.', ',') : '0'}%
            </span>
            <span className="num w-28 text-right">{formatTRY(d.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
