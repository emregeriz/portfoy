import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { todayISO } from '../lib/calc'
import {
  accountNeeds, blockedByIpo, fundingRows, talepRows, totalBlocked as sumBlocked,
  type AccountNeed, type FundingChoice,
} from '../lib/ipoFunding'
import type { Account, AccountBalance, IpoEntry, IpoRow, LedgerRow } from '../types/db'

export interface IpoStats {
  /** Katılım işaretli hesap sayısı */
  accountCount: number
  totalRequested: number
  totalAllocated: number
  /** Satılmış lot toplamı */
  totalSold: number
  /** Hâlâ elde tutulan lot */
  openLot: number
  /** Düşen lotun maliyeti */
  cost: number
  /** Dağıtımdan geri yatan toplam tutar */
  refund: number
  /** Satışlardan gelen toplam tutar */
  proceeds: number
  /** Satılan lottan kalıcılaşan kâr */
  realized: number
  /** Elde tutulan lotun güncel değeri; fiyat yoksa null */
  holding: number | null
  /** Elde tutulanın kâğıt üstündeki kârı; fiyat yoksa null */
  unrealized: number | null
  /** Gerçekleşen + açık kâr; fiyat yoksa yalnızca gerçekleşen */
  profit: number | null
}

/**
 * Bir arzın hesap bazlı toplamları. Dashboard ve Halka Arz sayfası aynı
 * hesabı kullansın diye ortak.
 *
 * Satış hesap bazlı olduğu için kâr iki parçadan oluşur: satılan lotun
 * gerçekleşen kârı ve elde kalan lotun güncel fiyata göre açık kârı.
 */
export function ipoStats(ipo: IpoRow, entries: IpoEntry[], price: number | null): IpoStats {
  const joined = entries.filter((e) => e.ipo_id === ipo.id && e.participated)
  const lot = Number(ipo.lot_price ?? 0)

  let totalRequested = 0
  let totalAllocated = 0
  let totalSold = 0
  let proceeds = 0
  let realized = 0
  for (const e of joined) {
    const req = Number(e.requested_lot)
    const alloc = Number(e.allocated_lot)
    const sold = Number(e.sold_lot ?? 0)
    const soldPrice = Number(e.sold_price ?? 0)
    totalRequested += req
    totalAllocated += alloc
    totalSold += sold
    proceeds += sold * soldPrice
    realized += sold * (soldPrice - lot)
  }

  const openLot = Math.max(totalAllocated - totalSold, 0)
  const cost = totalAllocated * lot
  const holding = price != null ? openLot * price : null
  const unrealized = holding != null ? holding - openLot * lot : null
  const refund = joined.reduce(
    (s, e) => s + Math.max(Number(e.requested_lot) - Number(e.allocated_lot), 0) * lot,
    0
  )

  return {
    accountCount: joined.length,
    totalRequested,
    totalAllocated,
    totalSold,
    openLot,
    cost,
    refund,
    proceeds,
    realized,
    holding,
    unrealized,
    profit: unrealized != null ? realized + unrealized : realized,
  }
}

/**
 * Halka arz veri katmanı.
 *
 * Para akışı `account_ledger` üzerinden yürür: talep verilince bloke edilen
 * tutar "talep" (−), dağıtımda geri yatan tutar "iade" (+), satış geliri
 * "satis", hesaplar arası aktarım "transfer" (biri eksi biri artı çift
 * kayıt), sistemden çıkan para "cikis". Hesap bakiyesi bu hareketlerin
 * toplamıdır — yani hesapta duran para hem o kişinin hesabında görünür hem
 * de senin toplam varlığına girer.
 *
 * Talep ve iade birlikte çalışır: ikisi de yazıldığında hesapta net olarak
 * yalnızca düşen lotun maliyeti kalır. Talep tarafı yazılmazsa iade yoktan
 * var olmuş para gibi görünür ve bakiye şişer — hesapta zaten duran parayla
 * arza girmenin defterdeki karşılığı budur.
 *
 * Dağıtım ve satış kayıtları yeniden hesaplanabilir olsun diye ilgili
 * hareketler önce silinip yeniden yazılır; iki kez "dağıtıldı" demek parayı
 * iki kez eklemez.
 */
export function useIpos(userId?: string | null) {
  const [ipos, setIpos] = useState<IpoRow[]>([])
  const [entries, setEntries] = useState<IpoEntry[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [balances, setBalances] = useState<AccountBalance[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const ipoQuery = supabase.from('ipos').select('*').order('ipo_date', { ascending: false, nullsFirst: false })
    const entryQuery = supabase.from('ipo_entries').select('*')
    const ledgerQuery = supabase.from('account_ledger').select('*').order('date', { ascending: false })
    const balQuery = supabase.from('v_account_balances').select('*')
    const accQuery = supabase.from('accounts').select('*').order('name')
    const [ipoRes, entryRes, ledgerRes, balRes, accRes] = await Promise.all([
      userId ? ipoQuery.eq('user_id', userId) : ipoQuery,
      userId ? entryQuery.eq('user_id', userId) : entryQuery,
      // Defter herkese açık okunuyor; kapsam verilmişse kendi satırlarına daralt
      userId ? ledgerQuery.eq('user_id', userId) : ledgerQuery,
      userId ? balQuery.eq('user_id', userId) : balQuery,
      userId ? accQuery.eq('user_id', userId) : accQuery,
    ])
    setError(
      ipoRes.error?.message ?? entryRes.error?.message ?? ledgerRes.error?.message ?? accRes.error?.message ?? null
    )
    setIpos((ipoRes.data ?? []) as IpoRow[])
    setEntries((entryRes.data ?? []) as IpoEntry[])
    setLedger((ledgerRes.data ?? []) as LedgerRow[])
    setBalances((balRes.data ?? []) as AccountBalance[])
    setAccounts((accRes.data ?? []) as Account[])
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  // ------------------------------------------------------- talep karşılığı
  /**
   * Blokenin yazılacağı gün — daha önce yazılmışsa aynı gün korunur, yoksa
   * arzın talep tarihi. Katılımı düzeltmek hareketi bugüne kaydırmasın diye.
   */
  const talepDateOf = useCallback(
    (ipoId: string, ipo?: IpoRow | null) =>
      ledger.find((l) => l.ipo_id === ipoId && l.kind === 'talep')?.date ?? ipo?.ipo_date ?? todayISO(),
    [ledger]
  )

  /**
   * Talep verilince hesaplardan bloke edilen parayı deftere yazar.
   *
   * `talep` satırları her çağrıda silinip yeniden yazılır — hesap ekleyip
   * çıkarmak ya da lotu düzeltmek bloke tutarını ikiye katlamaz.
   *
   * `choices` verilirse açığı kapatan hareketler de yazılır: "kendi
   * hesabımdan" transfer çifti, "dışarıdan" tek `giris` satırı, "hesaptaki
   * parayla" hiçbir şey. Bunlar da arza bağlı yazıldığı için modalı ikinci
   * kez açmak parayı iki kez atmaz; önce eskiler silinir.
   *
   * `choices` verilmezse yalnızca bloke tazelenir, kaynak seçimine
   * dokunulmaz — kutucuk işaretlerken istenmeyen para hareketi olmasın diye.
   */
  const settleSubscription = useCallback(
    async (ipo: IpoRow, date: string, choices?: Record<string, FundingChoice>): Promise<AccountNeed[]> => {
      // Katılım ve defter aynı işlemde değişmiş olabilir; veritabanının
      // güncel hâlinden oku, state'e güvenme.
      const [entryRes, ledRes, balRes] = await Promise.all([
        supabase.from('ipo_entries').select('*').eq('ipo_id', ipo.id),
        supabase.from('account_ledger').select('*').eq('ipo_id', ipo.id),
        supabase.from('v_account_balances').select('*').eq('user_id', ipo.user_id),
      ])
      const readErr = entryRes.error ?? ledRes.error ?? balRes.error
      if (readErr) throw new Error(readErr.message)

      const freshEntries = (entryRes.data ?? []) as IpoEntry[]
      const freshLedger = (ledRes.data ?? []) as LedgerRow[]
      const balMap = new Map<string, number>()
      for (const b of (balRes.data ?? []) as AccountBalance[]) balMap.set(b.account_id, Number(b.balance))

      const needs = accountNeeds(
        ipo, freshEntries, new Map(accounts.map((a) => [a.id, a.name])), balMap, freshLedger
      )

      if (choices) {
        // Karşılık hareketleri arza bağlı yazılır; yeniden seçim yapılınca
        // eskisi silinip yenisi yazılır ki para üst üste binmesin.
        const { error } = await supabase
          .from('account_ledger')
          .delete()
          .eq('ipo_id', ipo.id)
          .in('kind', ['giris', 'transfer'])
        if (error) throw new Error(error.message)
        const rows = fundingRows(ipo, needs, choices, date, () => crypto.randomUUID())
        if (rows.length) {
          const { error: insErr } = await supabase.from('account_ledger').insert(rows)
          if (insErr) throw new Error(insErr.message)
        }
      }

      const { error: delErr } = await supabase
        .from('account_ledger')
        .delete()
        .eq('ipo_id', ipo.id)
        .eq('kind', 'talep')
      if (delErr) throw new Error(delErr.message)

      const rows = talepRows(ipo, needs, date)
      if (rows.length) {
        const { error } = await supabase.from('account_ledger').insert(rows)
        if (error) throw new Error(error.message)
      }
      await load()
      return needs
    },
    [accounts, load]
  )

  // ---------------------------------------------------------------- arz
  const createIpo = useCallback(
    async (
      values: Partial<IpoRow> & { user_id: string; name: string },
      /** Baştan katılacak hesaplar — her birine arzın varsayılan lotu yazılır */
      accountIds: string[] = []
    ) => {
      const { data, error } = await supabase.from('ipos').insert(values).select().single()
      if (error) throw new Error(error.message)
      const ipo = data as IpoRow
      if (accountIds.length) {
        const lot = Number(ipo.default_lot ?? 0)
        const { error: entryErr } = await supabase.from('ipo_entries').insert(
          accountIds.map((account_id) => ({
            ipo_id: ipo.id,
            account_id,
            user_id: ipo.user_id,
            requested_lot: lot,
            participated: true,
            allocated_lot: 0,
          }))
        )
        if (entryErr) throw new Error(entryErr.message)
        // Bloke hemen yazılır ki bakiye bir an bile şişik görünmesin; parayı
        // nereden verdiğini sayfa hemen ardından "Talep karşılığı" ile sorar.
        await settleSubscription(ipo, ipo.ipo_date ?? todayISO())
      }
      await load()
      return ipo
    },
    [load, settleSubscription]
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
      // Ledger satırları FK "set null" olduğu için arzla birlikte silinmez —
      // yanlış girilen arzın parası bakiyede kalmasın diye burada elle
      // temizlenir. Arza bağlı olan her şey gider: bloke, iade, satış ve
      // talep karşılığı olarak yazılmış giriş/transferler (transferin iki
      // ayağı da arza bağlı yazıldığı için çift birlikte kalkar). Elle
      // yapılan hesap aktarımlarında ipo_id boştur, onlara dokunulmaz.
      const { error: ledErr } = await supabase.from('account_ledger').delete().eq('ipo_id', id)
      if (ledErr) throw new Error(ledErr.message)
      const { error } = await supabase.from('ipos').delete().eq('id', id)
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  /**
   * Arzın varsayılan lotunu değiştirir ve katılan hesapların talebini de
   * günceller — "her hesaptan aynı lot" kuralı bozulmasın diye.
   */
  const setDefaultLot = useCallback(
    async (ipoId: string, lot: number) => {
      const { error } = await supabase.from('ipos').update({ default_lot: lot }).eq('id', ipoId)
      if (error) throw new Error(error.message)
      const ids = entries.filter((e) => e.ipo_id === ipoId && e.participated).map((e) => e.id)
      if (ids.length) {
        const { error: e2 } = await supabase.from('ipo_entries').update({ requested_lot: lot }).in('id', ids)
        if (e2) throw new Error(e2.message)
      }
      // Talep tutarı lot × fiyat olduğu için lot değişince bloke de değişir
      const ipo = ipos.find((i) => i.id === ipoId)
      if (ipo) await settleSubscription({ ...ipo, default_lot: lot }, talepDateOf(ipoId, ipo))
      await load()
    },
    [entries, ipos, load, settleSubscription, talepDateOf]
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

  /**
   * Hesabın katılımını açıp kapatır. Açarken arzın varsayılan lotu doğrudan
   * yazılır — hesap hesap lot girmeye gerek kalmaz.
   */
  const toggleEntry = useCallback(
    async (ipo: IpoRow, accountId: string, on: boolean, userIdForRow: string) => {
      await setEntry(ipo.id, accountId, userIdForRow, {
        participated: on,
        ...(on ? { requested_lot: Number(ipo.default_lot ?? 0) } : {}),
      })
      // Katılımdan çıkan hesabın blokesi kalkar, girenin blokesi yazılır
      await settleSubscription(ipo, talepDateOf(ipo.id, ipo))
    },
    [setEntry, settleSubscription, talepDateOf]
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
  /**
   * Dağıtım sonrası geri yatan tutarı hesaplara yazar.
   * İade = (istenen lot − düşen lot) × lot fiyatı
   */
  const settleDistribution = useCallback(
    async (ipo: IpoRow, date: string) => {
      // Dağıtım aynı işlemde yeni yazıldığı için state henüz eski; iade
      // tutarını veritabanındaki güncel lotlardan hesapla.
      const { data: fresh, error: readErr } = await supabase
        .from('ipo_entries')
        .select('*')
        .eq('ipo_id', ipo.id)
      if (readErr) throw new Error(readErr.message)

      const rows = ((fresh ?? []) as IpoEntry[])
        .filter((e) => e.participated)
        .map((e) => ({
          entry: e,
          refund: Math.max(Number(e.requested_lot) - Number(e.allocated_lot), 0) * Number(ipo.lot_price ?? 0),
        }))
        .filter((x) => x.refund > 0)

      const { error: delErr } = await supabase
        .from('account_ledger')
        .delete()
        .eq('ipo_id', ipo.id)
        .eq('kind', 'iade')
      if (delErr) throw new Error(delErr.message)

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
    [load]
  )

  /**
   * Seçilen hesapların lotunu satar.
   *
   * Satış hesap bazlıdır: hepsini birden ya da tek tek satabilirsin. Gelen
   * para o hesabın bakiyesine yazılır; oradan kendi hesabına aktarmak ayrı
   * bir adımdır (transfer). Aynı hesabı yeniden satarsan eski satış kaydı
   * silinip yenisi yazılır.
   */
  const sellEntries = useCallback(
    async (ipo: IpoRow, entryIds: string[], price: number, date: string) => {
      if (!(price > 0)) throw new Error('Satış fiyatı sıfırdan büyük olmalı.')
      const targets = entries.filter(
        (e) => entryIds.includes(e.id) && e.participated && Number(e.allocated_lot) > 0
      )
      if (!targets.length) throw new Error('Satılacak hesap seçilmedi.')

      for (const e of targets) {
        const lot = Number(e.allocated_lot)
        const { error: delErr } = await supabase
          .from('account_ledger')
          .delete()
          .eq('ipo_id', ipo.id)
          .eq('account_id', e.account_id)
          .eq('kind', 'satis')
        if (delErr) throw new Error(delErr.message)

        const { error: insErr } = await supabase.from('account_ledger').insert({
          user_id: ipo.user_id,
          account_id: e.account_id,
          ipo_id: ipo.id,
          kind: 'satis',
          amount: lot * price,
          date,
          note: `${ipo.name} — satış geliri (${lot} lot × ${price})`,
        })
        if (insErr) throw new Error(insErr.message)

        const { error: upErr } = await supabase
          .from('ipo_entries')
          .update({ sold_lot: lot, sold_price: price, sold_date: date })
          .eq('id', e.id)
        if (upErr) throw new Error(upErr.message)
      }

      // Katılan her hesap satıldıysa arz kapanır — satır satır yazdığımız
      // için durumu veritabanının güncel hâlinden kontrol et.
      const { data: fresh } = await supabase
        .from('ipo_entries')
        .select('participated, allocated_lot, sold_lot')
        .eq('ipo_id', ipo.id)
      const remaining = ((fresh ?? []) as IpoEntry[]).filter(
        (e) => e.participated && Number(e.allocated_lot) > 0 && Number(e.sold_lot ?? 0) < Number(e.allocated_lot)
      )
      if (!remaining.length) {
        const { error } = await supabase
          .from('ipos')
          .update({ status: 'satildi', sold_price: price, sold_date: date })
          .eq('id', ipo.id)
        if (error) throw new Error(error.message)
      }

      await load()
      return targets.length
    },
    [entries, load]
  )

  /** Satışı geri alır — yanlış fiyat girildiğinde. */
  const unsellEntries = useCallback(
    async (ipo: IpoRow, entryIds: string[]) => {
      const targets = entries.filter((e) => entryIds.includes(e.id))
      if (!targets.length) return 0
      for (const e of targets) {
        const { error: delErr } = await supabase
          .from('account_ledger')
          .delete()
          .eq('ipo_id', ipo.id)
          .eq('account_id', e.account_id)
          .eq('kind', 'satis')
        if (delErr) throw new Error(delErr.message)
        const { error } = await supabase
          .from('ipo_entries')
          .update({ sold_lot: 0, sold_price: null, sold_date: null })
          .eq('id', e.id)
        if (error) throw new Error(error.message)
      }
      if (ipo.status === 'satildi') {
        const { error } = await supabase
          .from('ipos')
          .update({ status: 'islemde', sold_price: null, sold_date: null })
          .eq('id', ipo.id)
        if (error) throw new Error(error.message)
      }
      await load()
      return targets.length
    },
    [entries, load]
  )

  /**
   * Para aktarımı.
   *
   * `toAccountId` verilirse hesaplar arası aktarımdır: kaynaktan düşer,
   * hedefe eklenir. Para hâlâ sende olduğu için toplam değişmez.
   *
   * `toAccountId` null ise para sistemden çıkar ("dışarı"); yalnızca eksi
   * kayıt yazılır ve toplam bu kadar azalır.
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

      const transferId = toAccountId ? crypto.randomUUID() : null
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

      const { error } = await supabase
        .from('account_ledger')
        .insert(rows.map((r) => ({ ...r, transfer_id: transferId })))
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  // ------------------------------------------------------------ hesaplar
  /** Halka arz hesabı açar (kendi yatırım hesaplarından ayrı durur). */
  const createIpoAccount = useCallback(
    async (userIdForRow: string, name: string, note?: string | null) => {
      const clean = name.trim()
      if (!clean) throw new Error('Hesap adı gerekli.')
      const { error } = await supabase.from('accounts').insert({
        user_id: userIdForRow,
        name: clean,
        type: 'aracikurum',
        currency: 'TRY',
        is_active: true,
        is_ipo: true,
        note: note?.trim() || null,
      })
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  const removeAccount = useCallback(
    async (accountId: string) => {
      const { error } = await supabase.from('accounts').delete().eq('id', accountId)
      if (error) throw new Error(error.message)
      await load()
    },
    [load]
  )

  // ---------------------------------------------------------- türetilmiş
  /** Halka arz için kullanılan hesaplar */
  const ipoAccounts = useMemo(
    () => accounts.filter((a) => a.is_ipo && a.is_active),
    [accounts]
  )

  const balanceOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of balances) m.set(b.account_id, Number(b.balance))
    return m
  }, [balances])

  /** Arz bazlı hâlâ bloke duran para (talep − iade) */
  const blockedOf = useMemo(() => blockedByIpo(ledger), [ledger])

  /**
   * Dağıtımı açıklanmamış arzlarda bekleyen toplam para.
   *
   * Bu para hesap bakiyesinden düşmüştür ama kaybolmamıştır — aracı kurumda
   * dağıtım gününe kadar bloke durur. Net varlığa geri eklenmesi gerekir,
   * yoksa talep verdiğin gün servetin talep kadar azalmış görünür.
   */
  const blockedTotal = useMemo(() => sumBlocked(ipos, ledger), [ipos, ledger])

  /** Halka arz hesaplarında bekleyen toplam para — Dashboard'daki "iade" kalemi */
  const totalWaiting = useMemo(() => {
    const ids = new Set(ipoAccounts.map((a) => a.id))
    return balances
      .filter((b) => ids.has(b.account_id))
      .reduce((s, b) => s + Number(b.balance), 0)
  }, [balances, ipoAccounts])

  const entriesOf = useCallback(
    (ipoId: string) => entries.filter((e) => e.ipo_id === ipoId),
    [entries]
  )

  return {
    ipos, entries, ledger, balances, accounts, ipoAccounts, balanceOf, totalWaiting,
    blockedOf, blockedTotal,
    loading, error, reload: load, entriesOf,
    createIpo, updateIpo, removeIpo, setDefaultLot,
    setEntry, toggleEntry, applyAllocation,
    settleSubscription, talepDateOf, settleDistribution,
    sellEntries, unsellEntries, transfer,
    createIpoAccount, removeAccount,
  }
}
