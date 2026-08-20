import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useAssets } from '../hooks/useAssets'
import { useIpos, ipoStats } from '../hooks/useIpos'
import { usePrices } from '../hooks/usePrices'
import StatCard from '../components/StatCard'
import NumberInput from '../components/NumberInput'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatTRY, parseAmount, parseTRInput, toTRInput } from '../lib/currency'
import { todayISO } from '../lib/calc'
import type { IpoEntry, IpoRow, IpoState } from '../types/db'

const STATES: { value: IpoState; label: string; tone: string }[] = [
  { value: 'talep_verildi', label: 'Talep Verildi', tone: 'warn' },
  { value: 'dagitildi', label: 'Dağıtıldı', tone: 'accent' },
  { value: 'islemde', label: 'İşlem Görüyor', tone: 'accent' },
  { value: 'satildi', label: 'Satıldı', tone: 'pos' },
  { value: 'iptal', label: 'İptal', tone: 'muted' },
]
const stateMeta = (s: IpoState) => STATES.find((x) => x.value === s) ?? STATES[0]

type ModalState =
  | { type: 'ipo'; ipo: IpoRow | null }
  | { type: 'allocate'; ipo: IpoRow }
  | { type: 'trading'; ipo: IpoRow }
  | { type: 'sale'; ipo: IpoRow }
  | { type: 'account' }
  | { type: 'transfer'; accountId: string; max: number }
  | null

/** Aktarım hedefi olarak "dışarı" seçildiğinde kullanılan sabit. */
const EXTERNAL = '__disari__'

export default function IpoPage() {
  const { user } = useAuth()
  const { ensureAsset } = useAssets()
  const { bySymbol, refresh: refreshPrices, refreshing } = usePrices()
  const {
    ipos, entries, ledger, ipoAccounts, accounts, balanceOf, totalWaiting, loading, error,
    createIpo, updateIpo, removeIpo, toggleEntry, setEntry, applyAllocation,
    settleDistribution, sellEntries, unsellEntries, transfer, createIpoAccount, removeAccount,
  } = useIpos(user?.id)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Modal form durumları
  const [pickedAccounts, setPickedAccounts] = useState<Set<string>>(new Set())
  const [equalLot, setEqualLot] = useState('')
  const [allocMap, setAllocMap] = useState<Record<string, string>>({})
  const [saleSel, setSaleSel] = useState<Set<string>>(new Set())
  const [salePrice, setSalePrice] = useState('')
  const [saleDate, setSaleDate] = useState(todayISO())
  const [moveDate, setMoveDate] = useState(todayISO())
  const [formLotPrice, setFormLotPrice] = useState('')
  const [formLot, setFormLot] = useState('')

  /** Güncel fiyat: elle girilen kazanır, yoksa BIST kodundan otomatik gelen. */
  const priceOf = (ipo: IpoRow): number | null => {
    if (ipo.manual_price != null) return Number(ipo.manual_price)
    const code = ipo.bist_code?.trim().toUpperCase()
    const p = code ? bySymbol.get(code) : undefined
    return p ? Number(p.price) : null
  }
  const statsOf = (ipo: IpoRow) => ({ ...ipoStats(ipo, entries, priceOf(ipo)), price: priceOf(ipo) })
  const entryOf = (ipoId: string, accountId: string) =>
    entries.find((e) => e.ipo_id === ipoId && e.account_id === accountId)

  const active = useMemo(() => ipos.filter((i) => i.status !== 'iptal'), [ipos])

  const totals = useMemo(() => {
    let held = 0
    let realized = 0
    let open = 0
    for (const i of active) {
      const s = ipoStats(i, entries, priceOf(i))
      held += s.holding ?? s.openLot * Number(i.lot_price ?? 0)
      realized += s.realized
      open += s.unrealized ?? 0
    }
    return { held, realized, open, profit: realized + open }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, entries, bySymbol])

  /** Hesap bazlı kâr — hangi hesaptan ne kazandım */
  const byAccount = useMemo(() => {
    const map = new Map<string, { name: string; lot: number; cost: number; realized: number; open: number }>()
    for (const a of ipoAccounts) map.set(a.id, { name: a.name, lot: 0, cost: 0, realized: 0, open: 0 })
    for (const ipo of active) {
      const lotPrice = Number(ipo.lot_price ?? 0)
      const price = priceOf(ipo)
      for (const e of entries.filter((x) => x.ipo_id === ipo.id && x.participated)) {
        const row = map.get(e.account_id)
        if (!row) continue
        const alloc = Number(e.allocated_lot)
        const sold = Number(e.sold_lot ?? 0)
        row.lot += alloc
        row.cost += alloc * lotPrice
        row.realized += sold * (Number(e.sold_price ?? 0) - lotPrice)
        if (price != null) row.open += Math.max(alloc - sold, 0) * (price - lotPrice)
      }
    }
    return [...map.entries()]
      .map(([id, v]) => ({ id, ...v, total: v.realized + v.open }))
      .filter((r) => r.lot > 0 || r.cost > 0)
      .sort((a, b) => b.total - a.total)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, entries, ipoAccounts, bySymbol])

  const guard = async (fn: () => Promise<unknown>, keepOpen = false) => {
    setBusy(true)
    setFormError(null)
    try {
      await fn()
      if (!keepOpen) setModal(null)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- arz kaydı
  const openIpoModal = (ipo: IpoRow | null) => {
    setFormError(null)
    // Yeni arzda bütün halka arz hesapları baştan işaretli gelir — normalde
    // hepsinden aynı tutarla katılıyorsun, tek tek işaretlemek angarya olur.
    setPickedAccounts(new Set(ipo ? [] : ipoAccounts.map((a) => a.id)))
    setFormLotPrice(ipo?.lot_price != null ? String(ipo.lot_price) : '')
    setFormLot(ipo?.default_lot != null ? String(ipo.default_lot) : '')
    setModal({ type: 'ipo', ipo })
  }

  const submitIpo = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user || modal?.type !== 'ipo') return
    const fd = new FormData(e.currentTarget)
    const num = (k: string) => {
      const v = String(fd.get(k) ?? '').trim()
      return v ? parseAmount(v) : null
    }
    const code = String(fd.get('bist_code') ?? '').trim().toUpperCase() || null
    const values = {
      name: String(fd.get('name') ?? '').trim(),
      bist_code: code,
      ipo_date: String(fd.get('ipo_date') ?? '') || null,
      lot_price: num('lot_price'),
      default_lot: num('default_lot'),
      manual_price: num('manual_price'),
      note: String(fd.get('note') ?? '').trim() || null,
    }
    if (!values.name) return setFormError('Arz adı gerekli.')

    void guard(async () => {
      if (code) await ensureAsset(code, 'hisse', values.name)
      if (modal.ipo) await updateIpo(modal.ipo.id, values)
      else await createIpo({ ...values, user_id: user.id }, [...pickedAccounts])
    })
  }

  // ------------------------------------------------------------- dağıtım
  const openAllocate = (ipo: IpoRow) => {
    setFormError(null)
    const map: Record<string, string> = {}
    for (const e of entries.filter((x) => x.ipo_id === ipo.id && x.participated)) {
      map[e.account_id] = e.allocated_lot ? String(e.allocated_lot) : ''
    }
    setAllocMap(map)
    setEqualLot('')
    setMoveDate(todayISO())
    setModal({ type: 'allocate', ipo })
  }

  const submitAllocate = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'allocate' || !user) return
    const ipo = modal.ipo
    void guard(async () => {
      const equal = parseAmount(equalLot)
      if (equal > 0) {
        await applyAllocation(ipo.id, equal)
      } else {
        for (const [accountId, raw] of Object.entries(allocMap)) {
          const lot = parseAmount(raw)
          const current = Number(entryOf(ipo.id, accountId)?.allocated_lot ?? 0)
          if (lot !== current) await setEntry(ipo.id, accountId, user.id, { allocated_lot: lot })
        }
      }
      await settleDistribution(ipo, moveDate)
      await updateIpo(ipo.id, { status: 'dagitildi' })
    })
  }

  // -------------------------------------------------- işlem görmeye başlama
  const openTrading = (ipo: IpoRow) => {
    setFormError(null)
    setMoveDate(ipo.trade_start_date ?? todayISO())
    setModal({ type: 'trading', ipo })
  }

  const submitTrading = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'trading') return
    const ipo = modal.ipo
    void guard(async () => {
      await updateIpo(ipo.id, { status: 'islemde', trade_start_date: moveDate })
      // Tarih bugüne kadarsa fiyat hemen gelsin; ileri tarihliyse cron o sabah çeker
      if (moveDate <= todayISO() && ipo.bist_code) await refreshPrices()
    })
  }

  // --------------------------------------------------------------- satış
  const openSale = (ipo: IpoRow, only?: IpoEntry) => {
    setFormError(null)
    const sellable = entries.filter(
      (e) =>
        e.ipo_id === ipo.id &&
        e.participated &&
        Number(e.allocated_lot) > 0 &&
        Number(e.sold_lot ?? 0) < Number(e.allocated_lot)
    )
    setSaleSel(new Set(only ? [only.id] : sellable.map((e) => e.id)))
    setSalePrice(toTRInput(priceOf(ipo) ?? undefined))
    setSaleDate(todayISO())
    setModal({ type: 'sale', ipo })
  }

  const submitSale = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'sale') return
    void guard(() => sellEntries(modal.ipo, [...saleSel], parseTRInput(salePrice), saleDate))
  }

  if (loading) return <Spinner />

  const noAccounts = ipoAccounts.length === 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="Halka Arz"
        subtitle="Hesap bazlı talep, dağıtım, satış ve hesaplarda bekleyen para"
        actions={
          <>
            <button className="btn-ghost" onClick={() => { setFormError(null); setModal({ type: 'account' }) }}>
              + Hesap ekle
            </button>
            <button className="btn-primary" onClick={() => openIpoModal(null)} disabled={noAccounts}>
              + Arz Ekle
            </button>
          </>
        }
      />

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Halka Arz İadesi"
          value={totalWaiting}
          tone={totalWaiting > 0 ? 'pos' : 'neutral'}
          hint="Hesaplarda bekleyen, kendine aktarabileceğin para"
        />
        <StatCard title="Elde Tutulan Hisse" value={totals.held} hint="Satılmamış lotun güncel değeri" />
        <StatCard
          title="Toplam Kâr"
          value={totals.profit}
          tone={totals.profit >= 0 ? 'pos' : 'neg'}
          hint={`Gerçekleşen ${formatTRY(totals.realized)} · açık ${formatTRY(totals.open)}`}
        />
        <StatCard
          title="Arz Sayısı"
          value={String(active.length)}
          hint={`${ipoAccounts.length} halka arz hesabı`}
        />
      </div>

      {/* ------------------------------------------------- hesap bakiyeleri */}
      <Card
        title="Halka Arz Hesapları"
        actions={<span className="text-xs text-muted">Toplam {formatTRY(totalWaiting)}</span>}
      >
        {noAccounts ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-muted">
              Halka arza girdiğin hesapları buraya ekle — kendi yatırım hesaplarından ayrı durur,
              Hesaplar sayfasını kalabalıklaştırmaz.
            </p>
            <button className="btn-primary" onClick={() => { setFormError(null); setModal({ type: 'account' }) }}>
              + Halka arz hesabı ekle
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr>
                  <th className="th">Hesap</th>
                  <th className="th text-right">Bakiye</th>
                  <th className="th">Son hareket</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {ipoAccounts.map((a) => {
                  const bal = balanceOf.get(a.id) ?? 0
                  const last = ledger.find((l) => l.account_id === a.id)
                  return (
                    <tr key={a.id} className="hover:bg-surface2/50">
                      <td className="td">
                        <div className="font-medium">{a.name}</div>
                        {a.note && <div className="text-xs text-muted">{a.note}</div>}
                      </td>
                      <td className={`td text-right num ${bal > 0 ? 'text-pos' : 'text-muted'}`}>
                        {formatTRY(bal)}
                      </td>
                      <td className="td text-xs text-muted">
                        {last ? `${last.note ?? last.kind} · ${last.date}` : '—'}
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          <button
                            className="btn-ghost text-xs"
                            disabled={bal <= 0}
                            onClick={() => { setFormError(null); setModal({ type: 'transfer', accountId: a.id, max: bal }) }}
                          >
                            Para aktar
                          </button>
                          <button
                            className="btn-danger text-xs"
                            onClick={() => {
                              if (confirm(`"${a.name}" hesabı ve hareketleri silinsin mi?`)) {
                                void guard(() => removeAccount(a.id))
                              }
                            }}
                          >
                            Sil
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Buradaki para senin paran — Dashboard'da "halka arz iadesi" olarak toplam varlığına
          girer. "Para aktar" ile kendi hesabına çekebilir, hangi hesaptan ne çektiğini
          takip edebilirsin.
        </p>
      </Card>

      {/* ------------------------------------------------------------ arzlar */}
      {active.length === 0 ? (
        <Empty>
          {noAccounts ? 'Önce halka arz hesaplarını ekle.' : 'Henüz arz eklenmedi.'}
        </Empty>
      ) : (
        active.map((ipo) => {
          const s = statsOf(ipo)
          const meta = stateMeta(ipo.status)
          const open = expanded === ipo.id
          const joined = entries.filter((e) => e.ipo_id === ipo.id && e.participated)
          const future = ipo.trade_start_date && ipo.trade_start_date > todayISO()
          return (
            <Card key={ipo.id}>
              <div className="flex flex-wrap items-center gap-3">
                <button className="text-left flex-1 min-w-[220px]" onClick={() => setExpanded(open ? null : ipo.id)}>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{ipo.name}</span>
                    {ipo.bist_code && <span className="text-xs text-muted">{ipo.bist_code}</span>}
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {ipo.ipo_date ? format(parseISO(ipo.ipo_date), 'd MMM yyyy', { locale: tr }) : 'tarihsiz'}
                    {ipo.lot_price != null && ` · lot ${formatTRY(ipo.lot_price)}`}
                    {ipo.default_lot != null && ` · hesap başına ${formatNumber(ipo.default_lot, 0)} lot`}
                    {` · ${s.accountCount} hesap`}
                    {s.totalAllocated > 0 && ` · düşen ${formatNumber(s.totalAllocated, 0)} lot`}
                    {s.price != null && ` · güncel ${formatTRY(s.price)}`}
                  </div>
                  {future && (
                    <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                      {format(parseISO(ipo.trade_start_date as string), 'd MMMM', { locale: tr })} saat
                      10:01'de fiyat otomatik çekilecek
                    </div>
                  )}
                </button>

                <div className="text-right">
                  <div className="num font-semibold">{formatTRY(s.holding ?? s.cost)}</div>
                  {s.profit != null && s.profit !== 0 && (
                    <div className={`text-xs num ${s.profit >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {s.profit >= 0 ? '+' : ''}{formatTRY(s.profit)}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {ipo.status === 'talep_verildi' && (
                    <button className="btn-ghost text-xs" onClick={() => openAllocate(ipo)}>
                      Dağıtıldı
                    </button>
                  )}
                  {ipo.status === 'dagitildi' && (
                    <button className="btn-ghost text-xs" onClick={() => openTrading(ipo)}>
                      İşlem görmeye başladı
                    </button>
                  )}
                  {(ipo.status === 'islemde' || ipo.status === 'dagitildi') && s.openLot > 0 && (
                    <button className="btn-primary text-xs" onClick={() => openSale(ipo)}>
                      Sat
                    </button>
                  )}
                  {ipo.status !== 'talep_verildi' && (
                    <button className="btn-ghost text-xs" onClick={() => openAllocate(ipo)} title="Düşen lotu düzelt">
                      Dağıtımı düzelt
                    </button>
                  )}
                  {ipo.bist_code && (
                    <button
                      className="btn-ghost text-xs"
                      disabled={refreshing}
                      onClick={() => void refreshPrices()}
                      title={`${ipo.bist_code} güncel fiyatını BIST'ten çek`}
                    >
                      {refreshing ? 'Çekiliyor…' : '↻ Fiyat çek'}
                    </button>
                  )}
                  <button className="btn-ghost text-xs" onClick={() => openIpoModal(ipo)}>
                    Düzenle
                  </button>
                </div>
              </div>

              {open && (
                <div className="mt-4 border-t border-border pt-3">
                  {noAccounts ? (
                    <Empty>Halka arz hesabı yok.</Empty>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[820px]">
                        <thead>
                          <tr>
                            <th className="th">Katıldım</th>
                            <th className="th">Hesap</th>
                            <th className="th text-right">İstenen</th>
                            <th className="th text-right">Düşen</th>
                            <th className="th text-right">Talep tutarı</th>
                            <th className="th text-right">İade</th>
                            <th className="th text-right">Satış</th>
                            <th className="th text-right">Kâr</th>
                            <th className="th"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {ipoAccounts.map((a) => {
                            const e = entryOf(ipo.id, a.id)
                            const req = Number(e?.requested_lot ?? 0)
                            const alloc = Number(e?.allocated_lot ?? 0)
                            const sold = Number(e?.sold_lot ?? 0)
                            const soldPrice = e?.sold_price != null ? Number(e.sold_price) : null
                            const lot = Number(ipo.lot_price ?? 0)
                            const isIn = Boolean(e?.participated)
                            const price = s.price
                            const realized = sold * ((soldPrice ?? 0) - lot)
                            const openProfit = price != null ? Math.max(alloc - sold, 0) * (price - lot) : 0
                            const profit = realized + openProfit
                            return (
                              <tr key={a.id} className={isIn ? '' : 'opacity-50'}>
                                <td className="td">
                                  <input
                                    type="checkbox"
                                    className="w-4 h-4"
                                    checked={isIn}
                                    disabled={!user || busy}
                                    onChange={(ev) =>
                                      void guard(() => toggleEntry(ipo, a.id, ev.target.checked, user!.id), true)
                                    }
                                  />
                                </td>
                                <td className="td font-medium">{a.name}</td>
                                <td className="td text-right num">{req ? formatNumber(req, 0) : '—'}</td>
                                <td className="td text-right num">{alloc ? formatNumber(alloc, 0) : '—'}</td>
                                <td className="td text-right num text-muted">{formatTRY(req * lot)}</td>
                                <td className="td text-right num text-pos">
                                  {formatTRY(Math.max(req - alloc, 0) * lot)}
                                </td>
                                <td className="td text-right num text-xs">
                                  {sold > 0 && soldPrice != null ? (
                                    <span className="text-ink">
                                      {formatNumber(sold, 0)} lot × {formatTRY(soldPrice)}
                                      <span className="block text-muted">{e?.sold_date}</span>
                                    </span>
                                  ) : (
                                    <span className="text-muted">—</span>
                                  )}
                                </td>
                                <td className={`td text-right num ${profit >= 0 ? 'text-pos' : 'text-neg'}`}>
                                  {alloc > 0 ? formatTRY(profit) : '—'}
                                </td>
                                <td className="td text-right whitespace-nowrap">
                                  {isIn && alloc > 0 && (
                                    sold > 0 ? (
                                      <button
                                        className="btn-ghost text-xs"
                                        onClick={() => void guard(() => unsellEntries(ipo, [e!.id]), true)}
                                      >
                                        Satışı geri al
                                      </button>
                                    ) : (
                                      <button className="btn-ghost text-xs" onClick={() => openSale(ipo, e!)}>
                                        Sat
                                      </button>
                                    )
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted">
                    <span>{s.accountCount} hesaptan katılım</span>
                    <span>İstenen: {formatNumber(s.totalRequested, 0)} lot</span>
                    <span>Düşen: {formatNumber(s.totalAllocated, 0)} lot</span>
                    <span>Maliyet: {formatTRY(s.cost)}</span>
                    {s.refund > 0 && <span className="text-pos">İade: {formatTRY(s.refund)}</span>}
                    {s.proceeds > 0 && <span>Satış geliri: {formatTRY(s.proceeds)}</span>}
                    <button
                      className="btn-danger text-xs ml-auto"
                      onClick={() => {
                        if (confirm(`"${ipo.name}" arzı ve tüm kayıtları silinsin mi?`)) {
                          void guard(() => removeIpo(ipo.id), true)
                        }
                      }}
                    >
                      Sil
                    </button>
                  </div>
                  {joined.length === 0 && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      Hiçbir hesap işaretli değil — katıldığın hesapların kutusunu işaretle,
                      hesap başına {formatNumber(ipo.default_lot ?? 0, 0)} lot otomatik yazılır.
                    </p>
                  )}
                </div>
              )}
            </Card>
          )
        })
      )}

      {/* --------------------------------------------------- hesap bazlı kâr */}
      {byAccount.length > 0 && (
        <Card title="Hesap Bazlı Kâr">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr>
                  <th className="th">Hesap</th>
                  <th className="th text-right">Düşen lot</th>
                  <th className="th text-right">Maliyet</th>
                  <th className="th text-right">Gerçekleşen</th>
                  <th className="th text-right">Açık</th>
                  <th className="th text-right">Toplam kâr</th>
                  <th className="th text-right">Bakiye</th>
                </tr>
              </thead>
              <tbody>
                {byAccount.map((r) => (
                  <tr key={r.id}>
                    <td className="td font-medium">{r.name}</td>
                    <td className="td text-right num">{formatNumber(r.lot, 0)}</td>
                    <td className="td text-right num text-muted">{formatTRY(r.cost)}</td>
                    <td className={`td text-right num ${r.realized >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {formatTRY(r.realized)}
                    </td>
                    <td className={`td text-right num ${r.open >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {formatTRY(r.open)}
                    </td>
                    <td className={`td text-right num font-semibold ${r.total >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {formatTRY(r.total)}
                    </td>
                    <td className="td text-right num text-muted">{formatTRY(balanceOf.get(r.id) ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------- arz bazlı kâr */}
      {active.length > 0 && (
        <Card title="Arz Bazlı Kâr">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px]">
              <thead>
                <tr>
                  <th className="th">Arz</th>
                  <th className="th">Durum</th>
                  <th className="th text-right">Düşen lot</th>
                  <th className="th text-right">Maliyet</th>
                  <th className="th text-right">İade</th>
                  <th className="th text-right">Satış geliri</th>
                  <th className="th text-right">Kâr</th>
                </tr>
              </thead>
              <tbody>
                {active.map((ipo) => {
                  const s = statsOf(ipo)
                  const meta = stateMeta(ipo.status)
                  return (
                    <tr key={ipo.id}>
                      <td className="td font-medium">
                        {ipo.name}
                        {ipo.bist_code && <span className="ml-1 text-xs text-muted">{ipo.bist_code}</span>}
                      </td>
                      <td className="td"><Badge tone={meta.tone}>{meta.label}</Badge></td>
                      <td className="td text-right num">{formatNumber(s.totalAllocated, 0)}</td>
                      <td className="td text-right num text-muted">{formatTRY(s.cost)}</td>
                      <td className="td text-right num text-pos">{s.refund ? formatTRY(s.refund) : '—'}</td>
                      <td className="td text-right num">{s.proceeds ? formatTRY(s.proceeds) : '—'}</td>
                      <td className={`td text-right num font-semibold ${(s.profit ?? 0) >= 0 ? 'text-pos' : 'text-neg'}`}>
                        {s.profit != null ? formatTRY(s.profit) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ modallar */}
      <Modal
        open={modal?.type === 'ipo'}
        title={modal?.type === 'ipo' && modal.ipo ? 'Arzı Düzenle' : 'Yeni Arz'}
        onClose={() => setModal(null)}
      >
        {modal?.type === 'ipo' && (
          <form onSubmit={submitIpo} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Arz adı</label>
                <input name="name" className="w-full" defaultValue={modal.ipo?.name ?? ''} autoFocus required />
              </div>
              <div>
                <label className="label">BIST kodu</label>
                <input
                  name="bist_code"
                  className="w-full uppercase"
                  placeholder="ABCDE"
                  defaultValue={modal.ipo?.bist_code ?? ''}
                />
              </div>
              <div>
                <label className="label">Talep tarihi</label>
                <input type="date" name="ipo_date" className="w-full" defaultValue={modal.ipo?.ipo_date ?? todayISO()} />
              </div>
              <div>
                <label className="label">Lot fiyatı (₺)</label>
                <input
                  name="lot_price"
                  className="w-full num"
                  inputMode="decimal"
                  value={formLotPrice}
                  onChange={(ev) => setFormLotPrice(ev.target.value)}
                />
              </div>
              <div>
                <label className="label">Hesap başına istenen lot</label>
                <input
                  name="default_lot"
                  className="w-full num"
                  inputMode="decimal"
                  value={formLot}
                  onChange={(ev) => setFormLot(ev.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Güncel fiyat (elle — boşsa BIST'ten çekilir)</label>
                <input
                  name="manual_price"
                  className="w-full num"
                  inputMode="decimal"
                  defaultValue={modal.ipo?.manual_price ?? ''}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Not</label>
                <input name="note" className="w-full" defaultValue={modal.ipo?.note ?? ''} />
              </div>
            </div>

            {(() => {
              const lot = parseAmount(formLot)
              const price = parseAmount(formLotPrice)
              const per = lot * price
              const count = modal.ipo
                ? entries.filter((e) => e.ipo_id === modal.ipo!.id && e.participated).length
                : pickedAccounts.size
              if (!(per > 0)) return null
              return (
                <div className="rounded-lg bg-surface2 px-3 py-2 text-sm space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted">Hesap başına yatan para</span>
                    <span className="num">{formatTRY(per)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">{count} hesap · toplam talep</span>
                    <span className="num font-semibold">{formatTRY(per * count)}</span>
                  </div>
                </div>
              )
            })()}

            {!modal.ipo && (
              <div>
                <label className="label">Katıldığın hesaplar</label>
                <div className="rounded-lg border border-border divide-y divide-border max-h-52 overflow-y-auto">
                  {ipoAccounts.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface2">
                      <input
                        type="checkbox"
                        className="w-4 h-4"
                        checked={pickedAccounts.has(a.id)}
                        onChange={(ev) => {
                          const next = new Set(pickedAccounts)
                          if (ev.target.checked) next.add(a.id)
                          else next.delete(a.id)
                          setPickedAccounts(next)
                        }}
                      />
                      {a.name}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  İşaretli her hesaba yukarıdaki lot sayısı yazılır — hesap hesap giriş yapmana
                  gerek yok. Sonradan da işaretleyip kaldırabilirsin.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'allocate'} title="Dağıtım" onClose={() => setModal(null)}>
        {modal?.type === 'allocate' && (
          <form onSubmit={submitAllocate} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div>
              <label className="label">Hesap başına düşen lot (eşit dağıtım)</label>
              <input
                className="w-full num"
                inputMode="decimal"
                placeholder="Örn. 30"
                autoFocus
                value={equalLot}
                onChange={(e) => setEqualLot(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted">
                Buraya yazarsan katılan bütün hesaplara aynı lot düşer. Hesaplara farklı lot
                düştüyse burayı boş bırak, aşağıdan tek tek gir.
              </p>
            </div>

            <div className="rounded-lg border border-border divide-y divide-border max-h-56 overflow-y-auto">
              {entries
                .filter((e) => e.ipo_id === modal.ipo.id && e.participated)
                .map((e) => {
                  const acc = accounts.find((a) => a.id === e.account_id)
                  return (
                    <div key={e.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="flex-1">{acc?.name ?? '—'}</span>
                      <span className="text-xs text-muted">istenen {formatNumber(e.requested_lot, 0)}</span>
                      <input
                        className="w-24 num text-right"
                        inputMode="decimal"
                        disabled={parseAmount(equalLot) > 0}
                        value={allocMap[e.account_id] ?? ''}
                        onChange={(ev) => setAllocMap({ ...allocMap, [e.account_id]: ev.target.value })}
                      />
                    </div>
                  )
                })}
            </div>

            <div>
              <label className="label">İade tarihi</label>
              <input type="date" className="w-full" value={moveDate} onChange={(e) => setMoveDate(e.target.value)} />
            </div>

            <p className="text-xs text-muted">
              Kaydedince (istenen − düşen) × lot fiyatı kadar para her hesabın bakiyesine iade
              olarak yazılır. Dağıtımı düzeltirsen iade kayıtları da yeniden hesaplanır, para iki
              kez eklenmez.
            </p>

            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'İşleniyor…' : 'Dağıtımı kaydet'}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'trading'} title="İşlem Görmeye Başlama" onClose={() => setModal(null)}>
        {modal?.type === 'trading' && (
          <form onSubmit={submitTrading} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div>
              <label className="label">İlk işlem günü</label>
              <input type="date" className="w-full" value={moveDate} onChange={(e) => setMoveDate(e.target.value)} autoFocus />
            </div>
            <p className="text-xs text-muted">
              Tarih bugün ya da geçmişse fiyat hemen çekilir. İleri bir tarih girersen o sabah
              <strong className="text-ink"> 10:01</strong>'de otomatik çekilir; sen girdiğinde değer hazır olur.
              {!modal.ipo.bist_code && (
                <span className="block mt-1 text-amber-600 dark:text-amber-400">
                  Bu arzın BIST kodu boş — fiyat çekilemez. Önce "Düzenle" ile kodu gir.
                </span>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'İşleniyor…' : 'Kaydet'}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'sale'} title="Satış" onClose={() => setModal(null)}>
        {modal?.type === 'sale' && (
          <form onSubmit={submitSale} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Satış fiyatı (lot başına)</label>
                <NumberInput className="w-full num" value={salePrice} onChange={setSalePrice} autoFocus />
              </div>
              <div>
                <label className="label">Satış tarihi</label>
                <input type="date" className="w-full" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="label">Satılacak hesaplar</label>
              <div className="rounded-lg border border-border divide-y divide-border max-h-56 overflow-y-auto">
                {entries
                  .filter((e) => e.ipo_id === modal.ipo.id && e.participated && Number(e.allocated_lot) > 0)
                  .map((e) => {
                    const acc = accounts.find((a) => a.id === e.account_id)
                    const already = Number(e.sold_lot ?? 0) > 0
                    return (
                      <label
                        key={e.id}
                        className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface2 ${already ? 'opacity-60' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="w-4 h-4"
                          checked={saleSel.has(e.id)}
                          onChange={(ev) => {
                            const next = new Set(saleSel)
                            if (ev.target.checked) next.add(e.id)
                            else next.delete(e.id)
                            setSaleSel(next)
                          }}
                        />
                        <span className="flex-1">{acc?.name ?? '—'}</span>
                        <span className="text-xs text-muted">
                          {formatNumber(e.allocated_lot, 0)} lot
                          {already && ` · satıldı ${formatTRY(Number(e.sold_price ?? 0))}`}
                        </span>
                      </label>
                    )
                  })}
              </div>
            </div>

            {saleSel.size > 0 && parseTRInput(salePrice) > 0 && (
              <div className="rounded-lg bg-surface2 px-3 py-2 text-sm">
                {(() => {
                  const price = parseTRInput(salePrice)
                  const lotPrice = Number(modal.ipo.lot_price ?? 0)
                  const sel = entries.filter((e) => saleSel.has(e.id))
                  const lots = sel.reduce((s, e) => s + Number(e.allocated_lot), 0)
                  const gross = lots * price
                  const profit = lots * (price - lotPrice)
                  return (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted">{sel.length} hesap · {formatNumber(lots, 0)} lot</span>
                        <span className="num">{formatTRY(gross)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">Kâr</span>
                        <span className={`num ${profit >= 0 ? 'text-pos' : 'text-neg'}`}>{formatTRY(profit)}</span>
                      </div>
                    </>
                  )
                })()}
              </div>
            )}

            <p className="text-xs text-muted">
              Satış geliri her hesabın kendi bakiyesine yazılır — para önce o kişide durur,
              istediğinde "Para aktar" ile kendine çekersin.
            </p>

            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy || saleSel.size === 0}>
                {busy ? 'Satılıyor…' : 'Sat'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'account'} title="Halka Arz Hesabı" onClose={() => setModal(null)}>
        {modal?.type === 'account' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!user) return
              const fd = new FormData(e.currentTarget)
              void guard(() =>
                createIpoAccount(user.id, String(fd.get('name') ?? ''), String(fd.get('note') ?? ''))
              )
            }}
            className="space-y-3"
          >
            {formError && <ErrorBox message={formError} />}
            <div>
              <label className="label">Hesap adı</label>
              <input name="name" className="w-full" placeholder="Örn. Babam — Ziraat" autoFocus required />
            </div>
            <div>
              <label className="label">Not</label>
              <input name="note" className="w-full" placeholder="Kimin hesabı, hangi aracı kurum" />
            </div>
            <p className="text-xs text-muted">
              Bu hesap yalnızca Halka Arz sayfasında listelenir; Hesaplar ve Nakit sayfalarındaki
              kendi hesaplarına karışmaz. Bakiyesi yine senin toplam varlığına girer.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'Ekleniyor…' : 'Ekle'}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'transfer'} title="Para Aktar" onClose={() => setModal(null)}>
        {modal?.type === 'transfer' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!user) return
              const fd = new FormData(e.currentTarget)
              const dest = String(fd.get('to') ?? '')
              void guard(() =>
                transfer(
                  user.id,
                  modal.accountId,
                  dest === EXTERNAL ? null : dest,
                  parseAmount(String(fd.get('amount') ?? '')),
                  String(fd.get('date') ?? todayISO()),
                  String(fd.get('note') ?? '').trim() || undefined
                )
              )
            }}
            className="space-y-3"
          >
            {formError && <ErrorBox message={formError} />}
            <p className="text-sm text-muted">
              {accounts.find((a) => a.id === modal.accountId)?.name} hesabında {formatTRY(modal.max)} var.
              Kendi hesabına aktarırsan para sende kalır, toplam varlığın değişmez. "Dışarı"
              seçersen para sistemden çıkar.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Nereye?</label>
                <select name="to" className="w-full" defaultValue="" required>
                  <option value="" disabled>Hedef seç…</option>
                  <optgroup label="Kendi hesaplarım">
                    {accounts.filter((a) => !a.is_ipo && a.is_active).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Halka arz hesapları">
                    {ipoAccounts.filter((a) => a.id !== modal.accountId).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                  <option value={EXTERNAL}>Dışarı — para çıkışı (toplamdan düşer)</option>
                </select>
              </div>
              <div>
                <label className="label">Tutar</label>
                <input name="amount" className="w-full num" inputMode="decimal" autoFocus defaultValue={modal.max} />
              </div>
              <div>
                <label className="label">Tarih</label>
                <input type="date" name="date" className="w-full" defaultValue={todayISO()} />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Not</label>
                <input name="note" className="w-full" placeholder="Örn. kendi hesabıma aldım" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'Aktarılıyor…' : 'Aktar'}</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
