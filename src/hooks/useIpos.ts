import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { AccountBalance, IpoEntry, IpoRow, LedgerRow } from '../types/db'

export interface IpoStats {
  accountCount: number
  totalRequested: number
  totalAllocated: number
  cost: number
  /** Elde tutulan hissenin güncel değeri; satıldıysa 0, fiyat yoksa null */
  holding: number | null
  /** Satıldıysa gerçekleşen, tutuluyorsa kâğıt üstündeki kâr */
  profit: number | null
}

/**
 * Bir arzın hesap bazlı toplamları. Dashboard ve halka arz sayfası aynı
 * hesabı kullansın diye ortak.
 */
export function ipoStats(ipo: IpoRow, entries: IpoEntry[], price: number | null): IpoStats {
  const joined = entries.filter((e) => e.ipo_id === ipo.id && e.participated)
  const lot = Number(ipo.lot_price ?? 0)
  const totalRequested = joined.reduce((s, e) => s + Number(e.requested_lot), 0)
  const totalAllocated = joined.reduce((s, e) => s + Number(e.allocated_lot), 0)
  const cost = totalAllocated * lot
  const holding = ipo.status === 'satildi' ? 0 : price != null ? totalAllocated * price : null
  const profit =
    ipo.status === 'satildi' && ipo.sold_price != null
      ? (Number(ipo.sold_price) - lot) * totalAllocated
      : holding != null
        ? holding - cost
        : null
  return { accountCount: joined.length, totalRequested, totalAllocated, cost, holding, profit }
}

/**
 * Halka arz veri katmanı.
 *
 * Para akışı ledger üzerinden yürür: dağıtımda geri yatan tutar "iade",
 * satış geliri "satis", hesaplar arası aktarım "transfer" (biri eksi biri
 * artı çift kayıt), sistemden çıkan para "cikis" olarak yazılır.
 * Hesap bakiyesi bu hareketlerin toplamıdır; iç aktarım çifti sıfırlandığı
 * için toplam varlığı değiştirmez, yalnızca "cikis" azaltır.
 *
 * Dağıtım ve satış kayıtları yeniden hesaplanabilir olsun diye önce o arza
 * ait eski hareketler silinip yeniden yazılır — iki kez "dağıtıldı" demek
 * parayı iki kez eklemez.
 */
export function useIpos(userId?: string | null) {
  const [ipos, setIpos] = useState<IpoRow[]>([])
  const [entries, setEntries] = useState<IpoEntry[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [balances, setBalances] = useState<AccountBalance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const ipoQuery = supabase.from('ipos').select('*').order('ipo_date', { ascending: false, nullsFirst: false })
    const [ipoRes, entryRes, ledgerRes, balRes] = await Promise.all([
      userId ? ipoQuery.eq('user_id', userId) : ipoQuery,
      supabase.from('ipo_entries').select('*'),
      supabase.from('account_ledger').select('*').order('date', { ascending: false }),
      supabase.from('v_account_balances').select('*'),
    ])
    setError(ipoRes.error?.message ?? entryRes.error?.message ?? ledgerRes.error?.message ?? null)
    setIpos((ipoRes.data ?? []) as IpoRow[])
    setEntries((entryRes.data ?? []) as IpoEntry[])
    setLedger((ledgerRes.data ?? []) as LedgerRow[])
    setBalances((balRes.data ?? []) as AccountBalance[])
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  // ---------------------------------------------------------------- arz
  const createIpo = useCallback(
    async (values: Partial<IpoRow> & { user_id: string; name: string }) => {
      const { data, error } = await supabase.from('ipos').insert(values).select().single()
      if (error) throw new Error(error.message)
      await load()
      return data as IpoRow
    },
    [load]
  )

  const updateIpo = useCallback(
    async (id: string, values: Partial<IpoRow>) => {
      const { error } = await supabase.from('ipos').update(values).eq('id', id)
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  const removeIpo = useCallback(
    async (id: string) => {
      const { error } = await supabase.from('ipos').delete().eq('id', id)
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  // ------------------------------------------------------------ katılım
  /** Hesap satırını oluşturur ya da günceller (arz × hesap tekil). */
  const setEntry = useCallback(
    async (
      ipoId: string,
      accountId: string,
      userIdForRow: string,
      patch: Partial<Pick<IpoEntry, 'requested_lot' | 'participated' | 'allocated_lot'>>
    ) => {
      const existing = entries.find((e) => e.ipo_id === ipoId && e.account_id === accountId)
      if (existing) {
        const { error } = await supabase.from('ipo_entries').update(patch).eq('id', existing.id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('ipo_entries').insert({
          ipo_id: ipoId,
          account_id: accountId,
          user_id: userIdForRow,
          requested_lot: 0,
          participated: false,
          allocated_lot: 0,
          ...patch,
        })
        if (error) throw new Error(error.message)
      }
      await load()
    },
    [entries, load]
  )

  /** Katılan tüm hesaplara aynı lot sayısını uygular. */
  const applyAllocation = useCallback(
    async (ipoId: string, lot: number) => {
      const targets = entries.filter((e) => e.ipo_id === ipoId && e.participated)
      if (!targets.length) throw new Error('Önce katıldığın hesapları işaretle.')
      const { error } = await supabase
        .from('ipo_entries')
        .update({ allocated_lot: lot })
        .in('id', targets.map((e) => e.id))
      if (error) throw new Error(error.message)
      await load()
    },
    [entries, load]
  )

  // ------------------------------------------------------- para akışı
  /** Belirli bir arza ait, belirli türdeki hareketleri temizler. */
  const clearMoves = async (ipoId: string, kind: 'iade' | 'satis') => {
    const { error } = await supabase.from('account_ledger').delete().eq('ipo_id', ipoId).eq('kind', kind)
    if (error) throw new Error(error.message)
  }

  /**
   * Dağıtım sonrası geri yatan tutarı hesaplara yazar.
   * İade = (istenen lot − düşen lot) × lot fiyatı
   */
  const settleDistribution = useCallback(
    async (ipo: IpoRow, date: string) => {
      const rows = entries
        .filter((e) => e.ipo_id === ipo.id && e.participated)
        .map((e) => ({
          entry: e,
          refund: Math.max(Number(e.requested_lot) - Number(e.allocated_lot), 0) * Number(ipo.lot_price ?? 0),
        }))
        .filter((x) => x.refund > 0)

      await clearMoves(ipo.id, 'iade')
      if (rows.length) {
        const { error } = await supabase.from('account_ledger').insert(
          rows.map((x) => ({
            user_id: ipo.user_id,
            account_id: x.entry.account_id,
            ipo_id: ipo.id,
            kind: 'iade',
            amount: x.refund,
            date,
            note: `${ipo.name} — dağıtım iadesi`,
          }))
        )
        if (error) throw new Error(error.message)
      }
      await load()
      return rows.length
    },
    [entries, load]
  )

  /** Satış gelirini, hisseyi aldığın hesaplara dağıtır. */
  const settleSale = useCallback(
    async (ipo: IpoRow, price: number, date: string) => {
      const rows = entries
        .filter((e) => e.ipo_id === ipo.id && e.participated && Number(e.allocated_lot) > 0)
        .map((e) => ({ entry: e, amount: Number(e.allocated_lot) * price }))

      await clearMoves(ipo.id, 'satis')
      if (rows.length) {
        const { error } = await supabase.from('account_ledger').insert(
          rows.map((x) => ({
            user_id: ipo.user_id,
            account_id: x.entry.account_id,
            ipo_id: ipo.id,
            kind: 'satis',
            amount: x.amount,
            date,
            note: `${ipo.name} — satış geliri`,
          }))
        )
        if (error) throw new Error(error.message)
      }
      await load()
      return rows.length
    },
    [entries, load]
  )

  /**
   * Para aktarımı.
   *
   * `toAccountId` verilirse hesaplar arası aktarımdır: kaynaktan düşer,
   * hedefe eklenir. Para hâlâ sende olduğu için toplam değişmez.
   *
   * `toAccountId` null ise para sistemden çıkar ("dışarı"); yalnızca
   * eksi kayıt yazılır ve toplam bu kadar azalır.
   */
  const transfer = useCallback(
    async (
      userIdForRow: string,
      fromAccountId: string,
      toAccountId: string | null,
      amount: number,
      date: string,
      note?: string
    ) => {
      if (amount <= 0) throw new Error('Tutar sıfırdan büyük olmalı.')
      if (toAccountId === fromAccountId) throw new Error('Kaynak ve hedef hesap aynı olamaz.')

      const rows = toAccountId
        ? [
            {
              user_id: userIdForRow, account_id: fromAccountId, kind: 'transfer',
              amount: -Math.abs(amount), date, note: note || 'Hesaplar arası aktarım',
            },
            {
              user_id: userIdForRow, account_id: toAccountId, kind: 'transfer',
              amount: Math.abs(amount), date, note: note || 'Hesaplar arası aktarım',
            },
          ]
        : [
            {
              user_id: userIdForRow, account_id: fromAccountId, kind: 'cikis',
              amount: -Math.abs(amount), date, note: note || 'Dışarı çıkış',
            },
          ]

      // Çift kaydı eşleştirmek için ortak bir kimlik üret
      const transferId = toAccountId ? crypto.randomUUID() : null
      const { error } = await supabase
        .from('account_ledger')
        .insert(rows.map((r) => ({ ...r, transfer_id: transferId })))
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  const balanceOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of balances) m.set(b.account_id, Number(b.balance))
    return m
  }, [balances])

  const totalWaiting = useMemo(
    () => balances.reduce((s, b) => s + Number(b.balance), 0),
    [balances]
  )

  return {
    ipos, entries, ledger, balances, balanceOf, totalWaiting,
    loading, error, reload: load,
    createIpo, updateIpo, removeIpo,
    setEntry, applyAllocation,
    settleDistribution, settleSale, transfer,
  }
}
