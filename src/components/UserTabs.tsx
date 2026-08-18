import type { Profile } from '../types/db'

export type ScopeValue = string // profil id'si veya 'toplam'

interface Props {
  profiles: Profile[]
  currentUserId?: string | null
  value: ScopeValue
  onChange: (v: ScopeValue) => void
  showTotal?: boolean
}

export default function UserTabs({
  profiles,
  currentUserId,
  value,
  onChange,
  showTotal = true,
}: Props) {
  const tabs = [
    ...profiles.map((p) => ({
      key: p.id,
      label: p.id === currentUserId ? 'Ben' : p.display_name,
      color: p.color ?? '#4f8cff',
    })),
    ...(showTotal && profiles.length > 1
      ? [{ key: 'toplam', label: 'Toplam', color: '#94a3b8' }]
      : []),
  ]

  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1">
      {tabs.map((t) => {
        const active = t.key === value
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              active ? 'text-white' : 'text-muted hover:text-slate-200'
            }`}
            style={active ? { background: t.color } : undefined}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
