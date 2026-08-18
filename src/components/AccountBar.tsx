import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { colorAt, type Slice } from '../lib/calc'
import { formatCompactTRY, formatTRY } from '../lib/currency'

export default function AccountBar({ data }: { data: Slice[] }) {
  if (!data.length) {
    return <div className="h-[280px] grid place-items-center text-sm text-muted">Veri yok.</div>
  }

  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 38 + 30)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="#243047" strokeDasharray="3 3" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fill: '#8b9ab3', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => formatCompactTRY(Number(v))}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={120}
          tick={{ fill: '#c7d2e3', fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: '#ffffff08' }}
          contentStyle={{
            background: '#1a2233',
            border: '1px solid #243047',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(v: any) => [formatTRY(Number(v)), 'Tutar']}
        />
        <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={20}>
          {data.map((d, i) => (
            <Cell key={d.key} fill={colorAt(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
