import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './useAuth'
import { todayISO } from '../lib/calc'
import { runNemaAccrual } from '../lib/cash'
import type { Account, LedgerRow } from '../types/db'

export interface CashAccount extends Account {
  balance: number
  /** Bugün işlemiş nema geliri */
  todayNema: number
  /** Bu hesapta bugüne kadar biriken toplam nema */
  totalNema: number
  lastMove: LedgerRow | null
}

/**
 * Hesaplardaki nakit — bakiye, para giriş/çıkışı, aktarım ve nemalandırma.
 *
 * Para hareketleri halka arz tarafıyla aynı deftere (`account_ledger`)
 * yazılır; hesabın bakiyesi tek yerden okunur ve Dashboard'daki
 * "hesaplarda bekleyen nakit" toplamı kendiliğinden doğru kalır.
 *
 * Hook yüklendiğinde nemalandırma tanımlı hesaplarda eksik günlerin faizi
 * işlenir — uygulama günlerce açılmasa da açıldığında geriye dönük tamamlanır.
 */
export function useCash(userId?: string | null) {
  const { user } = useAuth()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const today = todayISO()

  /** Yalnızca kendi verinde yazma yetkisi var — RLS de aynısını söyler */
  const canWrite = !!user && !!userId && user.id === userId

  const load = useCallback(async () => {
    if (!userId) {
      setAccounts([])
      setLedger([])
      setLoading(false)
      return
    }
    const [accRes, ledRes] = await Promise.all([
      // Halka arz hesapları burada listelenmez — onlar Halka Arz sayfasının işi
      supabase.from('accounts').select('*').eq('user_id', userId).eq('is_ipo', false).order('name'),
      supabase
        .from('account_ledger')
        .select('*')
        .eq('user_id', userId)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }),
    ])
    setError(accRes.error?.message ?? ledRes.error?.message ?? null)
    setAccounts((accRes.data ?? []) as Account[])
    setLedger((ledRes.data ?? []) as LedgerRow[])
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  // Eksik günlerin faizini işle, yazıldıysa defteri tazele
  useEffect(() => {
    if (!canWrite || !userId) return
    let alive = true
    runNemaAccrual(userId, today)
      .then((n) => {
        if (n > 0 && alive) void load()
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [canWrite, userId, today, load])

  // ------------------------------------------------------------ türetilmiş
  const cashAccounts = useMemo<CashAccount[]>(() => {
    const byAccount = new Map<string, LedgerRow[]>()
    for (const l of ledger) {
      const list = byAccount.get(l.account_id)
      if (list) list.push(l)
      else byAccount.set(l.account_id, [l])
    }
    return accounts.map((a) => {
      const rows = byAccount.get(a.id) ?? []
      let balance = 0
      let todayNema = 0
      let totalNema = 0
      for (const r of rows) {
        const amount = Number(r.amount)
        balance += amount
        if (r.kind === 'nema') {
          totalNema += amount
          if (r.date === today) todayNema += amount
        }
      }
      return { ...a, balance, todayNema, totalNema, lastMove: rows[0] ?? null }
    })
  }, [accounts, ledger, today])

  const balanceOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of cashAccounts) m.set(a.id, a.balance)
    return m
  }, [cashAccounts])

  const totals = useMemo(() => {
    let cash = 0
    let todayNema = 0
    let totalNema = 0
    let earning = 0
    for (const a of cashAccounts) {
      cash += a.balance
      todayNema += a.todayNema
      totalNema += a.totalNema
      if (Number(a.nema_rate) > 0 && a.balance > 0) earning += a.balance
    }
    return { cash, todayNema, totalNema, earning }
  }, [cashAccounts])

  // ------------------------------------------------------------- yazma
  const insertMove = useCallback(
    async (row: Record<string, unknown>) => {
      if (!user) throw new Error('Oturum bulunamadı.')
      const { error } = await supabase.from('account_ledger').insert({ user_id: user.id, ...row })
      if (error) throw new Error(error.message)
      await load()
    },
    [user, load]
  )

  /** Hesaba para yatırma — mevcut bakiyeyi ilk kez girerken de bu kullanılır. */
  const deposit = useCallback(
    (accountId: string, amount: number, date: string, note?: string | null) => {
      if (!(amount > 0)) throw new Error('Tutar sıfırdan büyük olmalı.')
      return insertMove({
        account_id: accountId,
        kind: 'giris',
        amount: Math.abs(amount),
        date,
        note: note?.trim() || 'Nakit girişi',
      })
    },
    [insertMove]
  )

  /** Hesaptan para çekme — para sistemden çıkar, toplam varlıktan düşer. */
  const withdraw = useCallback(
    (accountId: string, amount: number, date: string, note?: string | null) => {
      if (!(amount > 0)) throw new Error('Tutar sıfırdan büyük olmalı.')
      return insertMove({
        account_id: accountId,
        kind: 'cikis',
        amount: -Math.abs(amount),
        date,
        note: note?.trim() || 'Nakit çıkışı',
      })
    },
    [insertMove]
  )

  /**
   * Hesaplar arası aktarım — çift kayıt yazılır, toplam varlık değişmez.
   * Aynı `transfer_id` iki satırı eşleştirir.
   */
  const transfer = useCallback(
    async (from: string, to: string, amount: number, date: string, note?: string | null) => {
      if (!user) throw new Error('Oturum bulunamadı.')
      if (!(amount > 0)) throw new Error('Tutar sıfırdan büyük olmalı.')
      if (from === to) throw new Error('Kaynak ve hedef hesap aynı olamaz.')
      const transfer_id = crypto.randomUUID()
      const base = {
        user_id: user.id,
        kind: 'transfer',
        date,
        transfer_id,
        note: note?.trim() || 'Hesaplar arası aktarım',
      }
      const { error } = await supabase.from('account_ledger').insert([
        { ...base, account_id: from, amount: -Math.abs(amount) },
        { ...base, account_id: to, amount: Math.abs(amount) },
      ])
      if (error) throw new Error(error.message)
      await load()
    },
    [user, load]
  )

  /** Hareketi siler; aktarımın karşı bacağı da birlikte gider. */
  const removeMove = useCallback(
    async (row: LedgerRow) => {
      const q = supabase.from('account_ledger').delete()
      const { error } = row.transfer_id
        ? await q.eq('transfer_id', row.transfer_id)
        : await q.eq('id', row.id)
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  /**
   * Hesabın yıllık nemalandırma oranını (yüzde) günceller ve geçmiş
   * günlerin faizini hemen işler.
   */
  const setNemaRate = useCallback(
    async (accountId: string, ratePct: number, startFrom?: string | null) => {
      const patch: Record<string, unknown> = { nema_rate: ratePct }
      if (startFrom !== undefined) patch.nema_start = startFrom || null
      const { error } = await supabase.from('accounts').update(patch).eq('id', accountId)
      if (error) throw new Error(error.message)
      if (userId) await runNemaAccrual(userId, today, true)
      await load()
    },
    [load, userId, today]
  )

  /**
   * Hesabın nema geçmişini siler ve baştan işler.
   *
   * Oran yanlış girildiyse ya da geçmişe dönük bir para hareketi
   * eklenip/silindiyse defteri güncel oranla tutarlı hâle getirir.
   */
  const recalcNema = useCallback(
    async (accountId: string) => {
      if (!userId) throw new Error('Oturum bulunamadı.')
      const { error } = await supabase
        .from('account_ledger')
        .delete()
        .eq('account_id', accountId)
        .eq('kind', 'nema')
      if (error) throw new Error(error.message)
      await runNemaAccrual(userId, today, true)
      await load()
    },
    [userId, today, load]
  )

  /** Adı verilen hesapları yoksa oluşturur; var olanlara dokunmaz. */
  const ensureAccounts = useCallback(
    async (defs: { name: string; type: Account['type']; nema_rate?: number }[]) => {
      if (!user) throw new Error('Oturum bulunamadı.')
      const existing = new Set(accounts.map((a) => a.name.trim().toLocaleLowerCase('tr')))
      const rows = defs
        .filter((d) => !existing.has(d.name.trim().toLocaleLowerCase('tr')))
        .map((d) => ({
          user_id: user.id,
          name: d.name,
          type: d.type,
          currency: 'TRY',
          is_active: true,
          nema_rate: d.nema_rate ?? 0,
        }))
      if (!rows.length) return 0
      const { error } = await supabase.from('accounts').insert(rows)
      if (error) throw new Error(error.message)
      await load()
      return rows.length
    },
    [user, accounts, load]
  )

  return {
    accounts: cashAccounts,
    ledger,
    balanceOf,
    totals,
    canWrite,
    loading,
    error,
    reload: load,
    deposit,
    withdraw,
    transfer,
    removeMove,
    setNemaRate,
    recalcNema,
    ensureAccounts,
  }
}
