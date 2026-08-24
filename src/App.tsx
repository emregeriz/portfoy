import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import { MaskProvider, useMaskState } from './hooks/useMask'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Accounts from './pages/Accounts'
import Cash from './pages/Cash'
import Ipo from './pages/Ipo'
import Transactions from './pages/Transactions'
import Takip from './pages/Takip'
import Trades from './pages/Trades'
import Reminders from './pages/Reminders'
import { Spinner } from './components/ui'

function Protected() {
  const { session, loading } = useAuth()
  if (loading) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  return <Layout />
}

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
              <Route path="takip" element={<Takip />} />
              <Route path="accounts" element={<Accounts />} />
              <Route path="nakit" element={<Cash />} />
              <Route path="ipo" element={<Ipo />} />
              <Route path="transactions" element={<Transactions />} />
              <Route path="trades" element={<Trades />} />
              <Route path="reminders" element={<Reminders />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </MaskProvider>
    </ThemeProvider>
  )
}
