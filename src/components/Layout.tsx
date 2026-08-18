import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/snapshot/new', label: 'Yeni Giriş' },
  { to: '/history', label: 'Geçmiş' },
  { to: '/accounts', label: 'Hesaplar' },
  { to: '/ipo', label: 'Halka Arz' },
  { to: '/transactions', label: 'Gelir / Gider' },
  { to: '/debts', label: 'Borç & Alacak' },
  { to: '/compare', label: 'Karşılaştır' },
]

export default function Layout() {
  const { profile, user, signOut } = useAuth()
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-7xl px-4 h-14 flex items-center gap-4">
          <NavLink to="/" className="font-semibold tracking-tight text-ink shrink-0">
            ₺ Portföy
          </NavLink>

          <nav className="hidden md:flex items-center gap-1 flex-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink hover:bg-surface2'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span
              className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium border"
              style={{
                borderColor: (profile?.color ?? '#4f8cff') + '66',
                background: (profile?.color ?? '#4f8cff') + '1a',
                color: profile?.color ?? '#4f8cff',
              }}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: profile?.color ?? '#4f8cff' }}
              />
              {profile?.display_name ?? user?.email ?? '—'}
            </span>
            <button
              onClick={toggle}
              className="btn-ghost text-xs"
              aria-label="Tema değiştir"
              title={theme === 'dark' ? 'Aydınlık tema' : 'Karanlık tema'}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button onClick={handleSignOut} className="btn-ghost text-xs">
              Çıkış
            </button>
            <button
              className="md:hidden btn-ghost text-xs"
              onClick={() => setOpen((v) => !v)}
              aria-label="Menü"
            >
              ☰
            </button>
          </div>
        </div>

        {open && (
          <nav className="md:hidden border-t border-border grid grid-cols-2 gap-1 p-2">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-lg text-sm ${
                    isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface2'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
