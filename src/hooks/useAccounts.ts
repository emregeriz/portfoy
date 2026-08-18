import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Account } from '../types/db'

export function useAccounts(userId?: string | null) {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('accounts').select('*').order('name')
    if (userId) q = q.eq('user_id', userId)
    const { data, error } = await q
    if (error) setError(error.message)
    else {
      setAccounts((data ?? []) as Account[])
      setError(null)
    }
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { accounts, loading, error, reload: load }
}
