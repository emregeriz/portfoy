import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const isSupabaseConfigured = Boolean(url && key)

if (!isSupabaseConfigured) {
  console.warn(
    '[portfoy] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY tanımlı değil. .env dosyasını doldur.'
  )
}

export const supabase = createClient(url || 'http://localhost', key || 'public-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true },
})
