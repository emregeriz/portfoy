import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import NewSnapshot from './pages/NewSnapshot'
import History from './pages/History'
import Accounts from './pages/Accounts'
import Ipo from './pages/Ipo'
import Transactions from './pages/Transactions'
import Debts from './pages/Debts'
import Compare from './pages/Compare'
import Takip from './pages/Takip'
import { Spinner } from './components/ui'

function Protected() {
  const { session, loading } = useAuth()
  if (loading) return <Spinner />
  if (!session) return <Navigate to="/login" replace />
  return <Layout />
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route index element={<Dashboard />} />
          <Route path="takip" element={<Takip />} />
            <Route path="snapshot/new" element={<NewSnapshot />} />
            <Route path="snapshot/:id/edit" element={<NewSnapshot />} />
            <Route path="history" element={<History />} />
            <Route path="accounts" element={<Accounts />} />
            <Route path="ipo" element={<Ipo />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="debts" element={<Debts />} />
            <Route path="compare" element={<Compare />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  )
}
