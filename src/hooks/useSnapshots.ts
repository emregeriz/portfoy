import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { NetWorthRow, PositionWithRefs, Snapshot } from '../types/db'

export const POSITION_SELECT =
  '*, accounts:account_id (id, name, type), assets:asset_id (id, symbol, name, kind)'

export function useSnapshots(userId?: string | null) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('snapshots').select('*').order('snapshot_date', { ascending: false })
    if (userId) q = q.eq('user_id', userId)
    const { data } = await q
    setSnapshots((data ?? []) as Snapshot[])
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { snapshots, loading, reload: load }
}

export function useNetWorth(userId?: string | null) {
  const [rows, setRows] = useState<NetWorthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('v_net_worth').select('*').order('snapshot_date')
    if (userId) q = q.eq('user_id', userId)
    const { data, error } = await q
    setError(error ? error.message : null)
    setRows(
      ((data ?? []) as NetWorthRow[]).map((r) => ({
        ...r,
        total_assets_try: Number(r.total_assets_try),
        total_liabilities_try: Number(r.total_liabilities_try),
        net_worth_try: Number(r.net_worth_try),
      }))
    )
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { rows, loading, error, reload: load }
}

export function usePositions(snapshotId?: string | null) {
  const [positions, setPositions] = useState<PositionWithRefs[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!snapshotId) {
      setPositions([])
      setLoading(false)
      return
    }
    setLoading(true)
    const { data } = await supabase
      .from('positions')
      .select(POSITION_SELECT)
      .eq('snapshot_id', snapshotId)
      .order('created_at')
    setPositions((data ?? []) as unknown as PositionWithRefs[])
    setLoading(false)
  }, [snapshotId])

  useEffect(() => {
    void load()
  }, [load])

  return { positions, loading, reload: load }
}

/** Birden fazla snapshot için pozisyonları tek seferde çeker (Toplam sekmesi). */
export function usePositionsForSnapshots(snapshotIds: string[]) {
  const [positions, setPositions] = useState<PositionWithRefs[]>([])
  const [loading, setLoading] = useState(true)
  const key = snapshotIds.join(',')

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!key) {
        setPositions([])
        setLoading(false)
        return
      }
      setLoading(true)
      const { data } = await supabase
        .from('positions')
        .select(POSITION_SELECT)
        .in('snapshot_id', key.split(','))
      if (!cancelled) {
        setPositions((data ?? []) as unknown as PositionWithRefs[])
        setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [key])

  return { positions, loading }
}
