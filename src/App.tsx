import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import { MaskProvider, useMaskState } from './hooks/useMask'
import Layout from './components/Layout'
import TabbedPage, { type PageTab } from './components/PageTabs'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Accounts from './pages/Accounts'
import Cash from './pages/Cash'
import Ipo from './pages/Ipo'
import Daily from './pages/Daily'
import Transactions from './pages/Transactions'
import Takip from './pages/Takip'
import Trades from './pages/Trades'
import Goals from './pages/Goals'
import Reminders from './pages/Reminders'
import { Spinner } from './components/ui'

function Protected() {
  const { session, loading } = useAuth()
  if (loading) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  return <Layout />
}

/**
 * Üst menü başlıklarının altındaki sekmeler. `key` profiles.nav_hidden ile
 * eşleşir — "takip" yalnızca bir kullanıcıda görünür, diğerinde gizli.
 */
const TRADE_TABS: PageTab[] = [
  { key: 'trades', to: '/trades', label: 'Alım / Satım', end: true },
  { key: 'takip', to: '/trades/takip', label: 'Takip' },
]
const ACCOUNT_TABS: PageTab[] = [
  { key: 'accounts', to: '/accounts', label: 'Hesaplar', end: true },
  { key: 'nakit', to: '/accounts/nakit', label: 'Nakit' },
]
const DAILY_TABS: PageTab[] = [
  { key: 'gunluk', to: '/gunluk', label: 'Günlük Kâr', end: true },
  { key: 'transactions', to: '/gunluk/gelir-gider', label: 'Gelir / Gider' },
]

export default function App() {
  // Gizleme durumu burada duruyor ki değiştiğinde Routes ve altındaki tüm
  // sayfalar yeniden render olsun — tutarlar tek hamlede maskelensin.
  const mask = useMaskState()

  return (
    <ThemeProvider>
      <MaskProvider value={mask}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<Protected />}>
              <Route index element={<Dashboard />} />

              <Route path="trades" element={<TabbedPage items={TRADE_TABS} />}>
                <Route index element={<Trades />} />
                <Route path="takip" element={<Takip />} />
              </Route>

              <Route path="accounts" element={<TabbedPage items={ACCOUNT_TABS} />}>
                <Route index element={<Accounts />} />
                <Route path="nakit" element={<Cash />} />
              </Route>

              <Route path="ipo" element={<Ipo />} />

              <Route path="gunluk" element={<TabbedPage items={DAILY_TABS} />}>
                <Route index element={<Daily />} />
                <Route path="gelir-gider" element={<Transactions />} />
              </Route>

              <Route path="hedef" element={<Goals />} />
              <Route path="reminders" element={<Reminders />} />

              {/* Eski adresler — yer imleri ve paylaşılmış bağlantılar kopmasın */}
              <Route path="takip" element={<Navigate to="/trades/takip" replace />} />
              <Route path="nakit" element={<Navigate to="/accounts/nakit" replace />} />
              <Route path="transactions" element={<Navigate to="/gunluk/gelir-gider" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </MaskProvider>
    </ThemeProvider>
  )
}
