import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { CorporateAction, DividendRecord } from '../lib/holdings'

/**
 * Bedelsiz / bölünme ve temettü kayıtları.
 *
 * İkisi de portföy hesabına giren veri: şirket işlemleri adedi ve birim
 * maliyeti değiştirir, temettü getiriye eklenir. Tek hook'ta duruyorlar
 * çünkü ikisini de kullanan sayfalar aynı (Alım/Satım, Dashboard).
 *
 * Sembol ve hesap adı sorguda join'leniyor; computeHoldings eşleştirmeyi
 * bunlarla yapıyor.
 */
export interface ActionRow extends CorporateAction {
  id: string
  note: string | null
}

export interface DividendRow extends DividendRecord {
  id: string
  quantity: number | null
  gross_per_share: number | null
  net_amount: number
  note: string | null
}

interface Joined {
  assets: { symbol: string } | null
  accounts?: { name: string } | null
}

export function useCorporate(userId?: string | null) {
  const [actions, setActions] = useState<ActionRow[]>([])
  const [dividends, setDividends] = useState<DividendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) {
      setActions([])
      setDividends([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [actRes, divRes] = await Promise.all([
        supabase
          .from('corporate_actions')
          .select('id, asset_id, action_date, kind, ratio, note, assets(symbol)')
          .eq('user_id', userId)
          .order('action_date', { ascending: false }),
        supabase
          .from('dividends')
          .select(
            'id, asset_id, account_id, pay_date, quantity, gross_per_share, gross_amount, tax_amount, net_amount, note, assets(symbol), accounts(name)'
          )
          .eq('user_id', userId)
          .order('pay_date', { ascending: false }),
      ])
      if (actRes.error) throw new Error(actRes.error.message)
      if (divRes.error) throw new Error(divRes.error.message)

      setActions(
        ((actRes.data ?? []) as unknown as (ActionRow & Joined)[]).map((r) => ({
          ...r,
          ratio: Number(r.ratio),
          symbol: r.assets?.symbol ?? null,
        }))
      )
      setDividends(
        ((divRes.data ?? []) as unknown as (DividendRow & Joined)[]).map((r) => ({
          ...r,
          gross_amount: Number(r.gross_amount),
          tax_amount: Number(r.tax_amount),
          symbol: r.assets?.symbol ?? null,
          account_name: r.accounts?.name ?? null,
        }))
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { actions, dividends, loading, error, reload: load }
}
