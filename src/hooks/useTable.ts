import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Options {
  userId?: string | null
  orderBy?: string
  ascending?: boolean
  select?: string
}

/**
 * Basit CRUD hook'u — liabilities / receivables / transactions / ipo_participations
 * tabloları aynı okuma-yazma desenini paylaştığı için ortak.
 */
export function useTable<T extends { id: string }>(table: string, opts: Options = {}) {
  const { userId, orderBy = 'created_at', ascending = false, select = '*' } = opts
  const [rows, setRows] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from(table).select(select).order(orderBy, { ascending })
    if (userId) q = q.eq('user_id', userId)
    const { data, error } = await q
    setError(error ? error.message : null)
    setRows((data ?? []) as unknown as T[])
    setLoading(false)
  }, [table, select, orderBy, ascending, userId])

  useEffect(() => {
    void load()
  }, [load])

  const insert = useCallback(
    async (values: Record<string, unknown>) => {
      const { data, error } = await supabase.from(table).insert(values).select()
      if (error) throw new Error(error.message)
      await load()
      // Eklenen satır — çağıran taraf id'ye ihtiyaç duyabilir (ör. bağlı kayıt)
      return (data?.[0] ?? null) as T | null
    },
    [table, load]
  )

  const update = useCallback(
    async (id: string, values: Record<string, unknown>) => {
      const { error } = await supabase.from(table).update(values).eq('id', id)
      if (error) throw new Error(error.message)
      await load()
    },
    [table, load]
  )

  const remove = useCallback(
    async (id: string) => {
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) throw new Error(error.message)
      await load()
    },
    [table, load]
  )

  return { rows, loading, error, reload: load, insert, update, remove }
}
