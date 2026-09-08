import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export interface PageTab {
  /** `profiles.nav_hidden` ile eşleşir — kullanıcıya özel gizleme */
  key: string
  /** Mutlak yol: "/trades/takip" */
  to: string
  label: string
  /** Sekmenin kendisi kök yolsa (index) alt yollarda aktif görünmesin */
  end?: boolean
}

/**
 * Sayfa içi sekmeler. Üst menüdeki bir başlığın altında birden çok görünüm
 * toplanır: Alım/Satım altında Takip, Hesaplar altında Nakit, Günlük Kâr
 * altında Gelir/Gider. Yol tabanlıdır — her sekmenin kendi adresi var,
 * geri tuşu ve yer imi çalışır.
 *
 * Gizleme üst menüyle aynı mekanizma: profilin `nav_hidden` dizisinde
 * anahtarı olan sekme çizilmez ("takip" yalnız bir kullanıcıda görünür).
 */
export function PageTabs({ items }: { items: PageTab[] }) {
  const { profile } = useAuth()
  const hidden = new Set(profile?.nav_hidden ?? [])
  const tabs = items.filter((t) => !hidden.has(t.key))
  if (tabs.length < 2) return null
  return (
    <div className="flex gap-1 border-b border-border mb-5 overflow-x-auto">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `px-3 py-2 -mb-px text-sm whitespace-nowrap border-b-2 transition-colors ${
              isActive
                ? 'border-accent text-accent font-medium'
                : 'border-transparent text-muted hover:text-ink'
            }`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  )
}

/** Sekme çubuğu + alt yolun içeriği — App.tsx'te layout route olarak kullanılır */
export default function TabbedPage({ items }: { items: PageTab[] }) {
  return (
    <>
      <PageTabs items={items} />
      <Outlet />
    </>
  )
}
