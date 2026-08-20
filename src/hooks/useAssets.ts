import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Asset, AssetKind } from '../types/db'

export function useAssets() {
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await supabase.from('assets').select('*').order('symbol')
    setAssets((data ?? []) as Asset[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Sembolü olan varlığı bulur, yoksa oluşturur.
   *
   * Semboller **ortak katalogda** tutulur (`user_id = null`): kod, ad ve
   * tür kişisel veri değil, piyasa bilgisidir. Kişiye özel olan kısım —
   * kimin hangi sembolde ne kadar pozisyonu olduğu — trades/positions
   * tarafındadır ve RLS ile kapalıdır. Sembolü kullanıcıya bağlamak,
   * aynı kağıdı iki kullanıcının ayrı satırlarda tutmasına ve birinin
   * eklediği sembolün diğerine görünmemesine yol açıyordu.
   */
  const ensureAsset = useCallback(
    async (symbol: string, kind: AssetKind, name?: string) => {
      const clean = symbol.trim().toUpperCase()
      if (!clean) return null
      const existing = assets.find((a) => a.symbol.toUpperCase() === clean)
      if (existing) return existing
      const { data, error } = await supabase
        .from('assets')
        .insert({ symbol: clean, kind, name: name ?? clean, user_id: null })
        .select()
        .single()
      if (error) throw new Error(error.message)
      const created = data as Asset
      setAssets((prev) => [...prev, created].sort((a, b) => a.symbol.localeCompare(b.symbol)))
      return created
    },
    [assets]
  )

  return { assets, loading, reload: load, ensureAsset }
}
