import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export interface TakipItem {
  id: string
  user_id: string
  name: string
  sort_order: number
  created_at: string
}

/**
 * Takip sayfasının varlık kalemleri — kullanıcı bazlı.
 * Herkes kendi listesini tanımlar; yeni kayıt açarken kendi kalemleri gelir.
 */
export function useTakipItems(userId?: string | null) {
  const [items, setItems] = useState<TakipItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!userId) {
      setItems([])
      setLoading(false)
      return
    }
    const { data } = await supabase
      .from('takip_items')
      .select('*')
      .eq('user_id', userId)
      .order('sort_order')
    setItems((data ?? []) as TakipItem[])
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  /** Listede olmayan adları sona ekler. Var olanlara dokunmaz. */
  const addItems = useCallback(
    async (names: string[]) => {
      if (!userId) return
      const existing = new Set(items.map((i) => i.name.toLocaleLowerCase('tr')))
      const fresh = [...new Set(names.map((n) => n.trim()).filter(Boolean))].filter(
        (n) => !existing.has(n.toLocaleLowerCase('tr'))
      )
      if (!fresh.length) return
      const start = items.reduce((m, i) => Math.max(m, i.sort_order), 0)
      const { error } = await supabase.from('takip_items').insert(
        fresh.map((name, i) => ({ user_id: userId, name, sort_order: start + i + 1 }))
      )
      // Aynı ad iki sekmeden eklenirse benzersizlik kısıtı hata verir; önemsiz
      if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message)
      await load()
    },
    [userId, items, load]
  )

  const removeItem = useCallback(
    async (id: string) => {
      const { error } = await supabase.from('takip_items').delete().eq('id', id)
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  return { items, names: items.map((i) => i.name), loading, reload: load, addItems, removeItem }
}
