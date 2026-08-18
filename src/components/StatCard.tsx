import type { ReactNode } from 'react'
import { formatPercent, formatTRY } from '../lib/currency'

interface Props {
  title: string
  value: string | number
  change?: { absolute: number; percent: number | null } | null
  hint?: ReactNode
  tone?: 'neutral' | 'pos' | 'neg'
}

export default function StatCard({ title, value, change, hint, tone = 'neutral' }: Props) {
  const valueClass =
    tone === 'pos' ? 'text-pos' : tone === 'neg' ? 'text-neg' : 'text-ink'

  return (
    <div className="card">
      <div className="text-xs font-medium text-muted uppercase tracking-wide">{title}</div>
      <div className={`mt-2 text-2xl font-semibold num ${valueClass}`}>
        {typeof value === 'number' ? formatTRY(value) : value}
      </div>
      {change && change.percent !== null && (
        <div
          className={`mt-1 text-sm num ${change.absolute >= 0 ? 'text-pos' : 'text-neg'}`}
        >
          {formatPercent(change.percent)} ({change.absolute >= 0 ? '+' : ''}
          {formatTRY(change.absolute)})
        </div>
      )}
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  )
}
