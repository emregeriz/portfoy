import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { isSupabaseConfigured } from '../lib/supabase'
import { ErrorBox } from '../components/ui'

export default function Login() {
  const { session, signIn, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return null
  if (session) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await signIn(email.trim(), password)
    if (error) setError(error === 'Invalid login credentials' ? 'E-posta veya şifre hatalı.' : error)
    setBusy(false)
  }

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="text-3xl font-semibold tracking-tight">₺ Portföy</div>
          <p className="text-sm text-muted mt-1">Varlık & borç takibi</p>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-4">
            <ErrorBox message="Supabase ayarları eksik. .env dosyasına VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY ekleyip sunucuyu yeniden başlat." />
          </div>
        )}

        <form onSubmit={submit} className="card space-y-4">
          <div>
            <label className="label" htmlFor="email">
              E-posta
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Şifre
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <ErrorBox message={error} />}

          <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
            {busy ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>

          <p className="text-xs text-muted text-center">
            Kayıt kapalı. Kullanıcılar Supabase panelinden eklenir.
          </p>
        </form>
      </div>
    </div>
  )
}
