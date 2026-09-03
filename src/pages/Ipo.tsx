import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useAssets } from '../hooks/useAssets'
import { useIpos, ipoStats } from '../hooks/useIpos'
import { usePrices } from '../hooks/usePrices'
import StatCard from '../components/StatCard'
import NumberInput from '../components/NumberInput'
import IpoFeed from '../components/IpoFeed'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatPercent, formatTRY, parseAmount, parseTRInput, toTRInput } from '../lib/currency'
import {
  defaultChoices, shortNeeds, FUNDING_LABELS,
  type AccountNeed, type FundingChoice, type FundingSource,
} from '../lib/ipoFunding'
import { todayISO } from '../lib/calc'
import type { IpoEntry, IpoFeedItem, IpoRow, IpoState } from '../types/db'

const STATES: { value: IpoState; label: string; tone: string }[] = [
  { value: 'talep_verildi', label: 'Talep Verildi', tone: 'warn' },
  { value: 'dagitildi', label: 'Dağıtıldı', tone: 'accent' },
  { value: 'islemde', label: 'İşlem Görüyor', tone: 'accent' },
  { value: 'satildi', label: 'Satıldı', tone: 'pos' },
  { value: 'iptal', label: 'İptal', tone: 'muted' },
]
const stateMeta = (s: IpoState) => STATES.find((x) => x.value === s) ?? STATES[0]

type ModalState =
  | { type: 'ipo'; ipo: IpoRow | null; prefill?: { name: string; bist_code: string | null } }
  | { type: 'allocate'; ipo: IpoRow }
  | { type: 'trading'; ipo: IpoRow }
  | { type: 'sale'; ipo: IpoRow }
  | { type: 'account' }
  | { type: 'transfer'; accountId: string; max: number }
  | { type: 'funding'; ipo: IpoRow; needs: AccountNeed[] }
  | null

/** Aktarım hedefi olarak "dışarı" seçildiğinde kullanılan sabit. */
const EXTERNAL = '__disari__'

export default function IpoPage() {
  const { user } = useAuth()
  const { ensureAsset } = useAssets()
  const { bySymbol, refresh: refreshPrices, refreshing } = usePrices()
  const {
    ipos, entries, ledger, ipoAccounts, accounts, balanceOf, totalWaiting, blockedOf, blockedTotal,
    loading, error,
    createIpo, updateIpo, removeIpo, setDefaultLot, toggleEntry, setEntry, applyAllocation,
    settleSubscription, talepDateOf, settleDistribution, sellEntries, unsellEntries, transfer,
    createIpoAccount, removeAccount,
  } = useIpos(user?.id)

  /** Sol listedeki seçili arz — detay paneli bunu gösterir */
  const [selected, setSelected] = useState<string | null>(null)
  /** takip = kendi arzların, takvim = halkarz.com arz takvimi */
  const [tab, setTab] = useState<'takip' | 'takvim'>('takip')
  /** Hesap Bazlı Kâr tablosunun kapsamı — boş = tüm arzlar, dolu = tek arz id */
  const [profitScope, setProfitScope] = useState('')
  const [modal, setModal] = useState<ModalState>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Modal form durumları
  const [pickedAccounts, setPickedAccounts] = useState<Set<string>>(new Set())
  const [equalLot, setEqualLot] = useState('')
  const [allocMap, setAllocMap] = useState<Record<string, string>>({})
  /** Dağıtım modalında hesap başına istenen lot — yanlış girilen talep düzeltilebilir */
  const [reqMap, setReqMap] = useState<Record<string, string>>({})
  const [saleSel, setSaleSel] = useState<Set<string>>(new Set())
  const [salePrice, setSalePrice] = useState('')
  const [saleDate, setSaleDate] = useState(todayISO())
  const [moveDate, setMoveDate] = useState(todayISO())
  const [formLotPrice, setFormLotPrice] = useState('')
  const [formLot, setFormLot] = useState('')
  /** Talep karşılığı modalında hesap başına seçilen kaynak */
  const [fundChoices, setFundChoices] = useState<Record<string, FundingChoice>>({})

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
  /** İptal edilen arzlar listeden düşer ama kaybolmaz — geri alınabilir */
  const cancelled = useMemo(() => ipos.filter((i) => i.status === 'iptal'), [ipos])
  /** Seçim geçersizse (silindi/iptal oldu) ilk arza düşer */
  const selectedIpo = active.find((i) => i.id === selected) ?? active[0] ?? null

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

  /**
   * Hesap bazlı kâr — hangi hesaptan ne kazandım.
   * profitScope doluysa yalnızca o arz sayılır; lot/güncel fiyat o arzın
   * gerçek fiyatları olur. "Tümü"nde birden fazla arz ağırlıklı ortalamayla
   * birleşir, eldeki değer hesap başına toplanır.
   */
  const byAccount = useMemo(() => {
    const scoped = profitScope ? active.filter((i) => i.id === profitScope) : active
    const map = new Map<
      string,
      {
        name: string
        lot: number
        cost: number
        realized: number
        open: number
        /** Elde duran (satılmamış) lotların değeri — fiyatı yoksa arz fiyatıyla sayılır */
        heldValue: number
        openValue: number
        pricedOpenLot: number
      }
    >()
    for (const a of ipoAccounts)
      map.set(a.id, {
        name: a.name, lot: 0, cost: 0, realized: 0, open: 0,
        heldValue: 0, openValue: 0, pricedOpenLot: 0,
      })
    for (const ipo of scoped) {
      const lotPrice = Number(ipo.lot_price ?? 0)
      const price = priceOf(ipo)
      for (const e of entries.filter((x) => x.ipo_id === ipo.id && x.participated)) {
        const row = map.get(e.account_id)
        if (!row) continue
        const alloc = Number(e.allocated_lot)
        const sold = Number(e.sold_lot ?? 0)
        const openLot = Math.max(alloc - sold, 0)
        row.lot += alloc
        row.cost += alloc * lotPrice
        row.realized += sold * (Number(e.sold_price ?? 0) - lotPrice)
        row.heldValue += openLot * (price ?? lotPrice)
        if (price != null) {
          row.open += openLot * (price - lotPrice)
          row.openValue += openLot * price
          row.pricedOpenLot += openLot
        }
      }
    }
    return [...map.entries()]
      .map(([id, v]) => ({
        id,
        ...v,
        total: v.realized + v.open,
        /** Ağırlıklı ortalama lot (arz) fiyatı — tek arz seçiliyken o arzın fiyatı */
        avgLotPrice: v.lot > 0 ? v.cost / v.lot : null,
        /** Elde duran lotların ağırlıklı ortalama güncel fiyatı */
        avgPrice: v.pricedOpenLot > 0 ? v.openValue / v.pricedOpenLot : null,
        pct: v.cost > 0 ? ((v.realized + v.open) / v.cost) * 100 : null,
      }))
      .filter((r) => r.lot > 0 || r.cost > 0)
      .sort((a, b) => b.total - a.total)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, entries, ipoAccounts, bySymbol, profitScope])

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

  /** Takvimden gelen arzı "Yeni Arz" formuna önceden doldurur */
  const trackFromFeed = (f: IpoFeedItem) => {
    setFormError(null)
    setPickedAccounts(new Set(ipoAccounts.map((a) => a.id)))
    setFormLotPrice((f.detail?.fiyat ?? f.price_text ?? '').replace(/[^\d.,]/g, ''))
    setFormLot('')
    setModal({
      type: 'ipo',
      ipo: null,
      prefill: { name: f.name, bist_code: f.bist_code ?? f.detail?.bist_kodu ?? null },
    })
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
      if (modal.ipo) {
        await updateIpo(modal.ipo.id, values)
        const prevLot = modal.ipo.default_lot != null ? Number(modal.ipo.default_lot) : null
        const prevPrice = modal.ipo.lot_price != null ? Number(modal.ipo.lot_price) : null
        const lotChanged = values.default_lot != null && values.default_lot !== prevLot
        const priceChanged = values.lot_price != null && values.lot_price !== prevPrice
        // Talep lotu değişince katılan hesapların istenen lotu da güncellenir
        if (lotChanged) await setDefaultLot(modal.ipo.id, values.default_lot as number)
        // Bloke tutarı lot × fiyat olduğu için ikisinden biri değişince
        // yeniden yazılır. Değerler doğrudan formdan verilir — sayfa state'i
        // bu noktada henüz tazelenmemiş olabilir.
        if (lotChanged || priceChanged) {
          await settleSubscription({ ...modal.ipo, ...values } as IpoRow, talepDateOf(modal.ipo.id, modal.ipo))
        }
        // Dağıtım yapılmışsa iadeler yeni lot/fiyata göre yeniden yazılır
        if ((lotChanged || priceChanged) && modal.ipo.status !== 'talep_verildi') {
          const iadeDate =
            ledger.find((l) => l.ipo_id === modal.ipo!.id && l.kind === 'iade')?.date ?? todayISO()
          await settleDistribution({ ...modal.ipo, ...values } as IpoRow, iadeDate)
        }
      } else {
        const created = await createIpo({ ...values, user_id: user.id }, [...pickedAccounts])
        // Bloke yazıldı; sıra parayı nereden verdiğinde. Hesapta zaten para
        // varsa "hesaptaki parayla" seçili gelir, tek tıkla geçilir.
        if (pickedAccounts.size && Number(created.lot_price ?? 0) > 0 && Number(created.default_lot ?? 0) > 0) {
          openFunding(created)
          return
        }
      }
      setModal(null)
    }, true)
  }

  // ------------------------------------------------------- talep karşılığı
  /** Kendi yatırım hesapların — talep karşılığını buradan aktarırsın */
  const ownAccounts = useMemo(() => accounts.filter((a) => !a.is_ipo && a.is_active), [accounts])

  /**
   * Bloke satırı hiç yazılmamış arz — bu sürümden önce açılmış kayıtlar.
   * İade yazılıp talep yazılmadığında bakiye iade kadar şiştiği için sayfa
   * bunu uyarı olarak gösterir ve tek tıkla düzeltmeyi önerir.
   */
  const missingTalep = (ipo: IpoRow) =>
    Number(ipo.lot_price ?? 0) > 0 &&
    entries.some((e) => e.ipo_id === ipo.id && e.participated && Number(e.requested_lot) > 0) &&
    !ledger.some((l) => l.ipo_id === ipo.id && l.kind === 'talep')

  /**
   * Talep karşılığı modalını açar.
   *
   * Açılırken bloke satırlarını yeniden yazdırır: hem taze ihtiyaç listesini
   * buradan alır (yeni kurulan arzda sayfa state'i henüz tazelenmemiş olur),
   * hem de blokesi hiç yazılmamış eski arzlar bu adımda kendiliğinden
   * düzelir. İşlem idempotent — ikinci kez açmak parayı iki kez blokelemez.
   */
  const openFunding = (ipo: IpoRow) => {
    setFormError(null)
    const date = talepDateOf(ipo.id, ipo)
    void guard(async () => {
      const { needs, existing } = await settleSubscription(ipo, date)
      if (!needs.length) throw new Error('Bu arzda işaretli hesap yok — önce katıldığın hesapları seç.')
      // Deftere daha önce ne yazılmışsa o seçili gelir; hiçbir şey yoksa
      // "hesaptaki parayla" (açık zaten açılış bakiyesi olarak yazıldı). Tek
      // yatırım hesabın varsa "kendi hesabımdan"a geçince kaynak hazır olsun.
      const only = ownAccounts.length === 1 ? ownAccounts[0].id : null
      const base = defaultChoices(needs, existing)
      for (const n of needs) {
        const c = base[n.accountId]
        if (!c.fromAccountId) base[n.accountId] = { ...c, fromAccountId: only }
      }
      setFundChoices(base)
      setMoveDate(date)
      setModal({ type: 'funding', ipo, needs })
    }, true)
  }

  const setFundChoice = (accountId: string, patch: Partial<FundingChoice>) =>
    setFundChoices((prev) => {
      const current: FundingChoice = prev[accountId] ?? { source: 'mevcut' }
      return { ...prev, [accountId]: { ...current, ...patch } }
    })

  /** Üstteki "hepsine uygula" — yalnızca açığı olan hesapları etkiler */
  const applyFundingToAll = (needs: AccountNeed[], source: FundingSource) =>
    setFundChoices((prev) => {
      const next = { ...prev }
      for (const n of shortNeeds(needs)) {
        next[n.accountId] = { source, fromAccountId: prev[n.accountId]?.fromAccountId ?? ownAccounts[0]?.id ?? null }
      }
      return next
    })

  const submitFunding = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'funding') return
    void guard(() => settleSubscription(modal.ipo, moveDate, fundChoices))
  }

  // ------------------------------------------------------------- dağıtım
  const openAllocate = (ipo: IpoRow) => {
    setFormError(null)
    const map: Record<string, string> = {}
    const req: Record<string, string> = {}
    for (const e of entries.filter((x) => x.ipo_id === ipo.id && x.participated)) {
      map[e.account_id] = e.allocated_lot ? String(e.allocated_lot) : ''
      req[e.account_id] = e.requested_lot ? String(e.requested_lot) : ''
    }
    setAllocMap(map)
    setReqMap(req)
    setEqualLot('')
    // Daha önce iade yazılmışsa aynı tarihi koru — düzeltme tarihi kaydırmasın
    const iadeDate = ledger.find((l) => l.ipo_id === ipo.id && l.kind === 'iade')?.date
    setMoveDate(iadeDate ?? todayISO())
    setModal({ type: 'allocate', ipo })
  }

  const submitAllocate = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'allocate' || !user) return
    const ipo = modal.ipo
    void guard(async () => {
      // Yanlış girilen talep (istenen lot) da buradan düzeltilir
      for (const [accountId, raw] of Object.entries(reqMap)) {
        const lot = parseAmount(raw)
        const current = Number(entryOf(ipo.id, accountId)?.requested_lot ?? 0)
        if (lot !== current) await setEntry(ipo.id, accountId, user.id, { requested_lot: lot })
      }
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
      // Düzeltme sonraki aşamaları geri sarmasın — durum yalnızca ilk dağıtımda ilerler
      if (ipo.status === 'talep_verildi') await updateIpo(ipo.id, { status: 'dagitildi' })
    })
  }

  /**
   * Fiyatı tazelemeden önce BIST kodunun ortak varlık katalogunda kaydı
   * olduğundan emin olur. `fetch-prices` yalnızca `assets` tablosundaki
   * sembolleri çeker; takvimden açılan arzın kodu oraya hiç yazılmadığı için
   * kâğıt işlem görmeye başlasa bile fiyat gelmiyor, kâr ₺0,00 kalıyordu.
   */
  const refreshWithAsset = async (ipo: IpoRow) => {
    const code = ipo.bist_code?.trim().toUpperCase()
    if (code) await ensureAsset(code, 'hisse', ipo.name)
    await refreshPrices()
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
      if (moveDate <= todayISO() && ipo.bist_code) await refreshWithAsset(ipo)
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

      <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1">
        {(
          [
            ['takip', 'Arzlarım'],
            ['takvim', 'Arz Takvimi'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className={`px-3 py-1.5 rounded-md text-sm ${
              tab === v ? 'bg-surface2 text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'takvim' && <IpoFeed onTrack={trackFromFeed} />}

      {tab === 'takip' && (
      <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Halka Arz İadesi"
          value={totalWaiting}
          tone={totalWaiting > 0 ? 'pos' : 'neutral'}
          hint="Hesaplarda bekleyen, kendine aktarabileceğin para"
        />
        {blockedTotal > 0.005 ? (
          <StatCard
            title="Arzda Bloke"
            value={blockedTotal}
            tone="warn"
            hint="Talebi verilmiş, dağıtımı beklenen para — hâlâ senin, aracı kurumda duruyor"
          />
        ) : (
          <StatCard title="Elde Tutulan Hisse" value={totals.held} hint="Satılmamış lotun güncel değeri" />
        )}
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

      {/* ------------- hesap bakiyeleri + hesap bazlı kâr — 6/6 yan yana */}
      <div className="grid gap-4 lg:grid-cols-2 items-start">
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
                              const msg =
                                bal > 0.004
                                  ? `"${a.name}" hesabında ${formatTRY(bal)} duruyor — silersen bu para ve arz katılımları da silinir, alım/satım kayıtları hesapsız kalır. Yine de silinsin mi?`
                                  : `"${a.name}" hesabı, hareketleri ve arz katılımları silinsin mi? Alım/satım kayıtları hesapsız kalır.`
                              if (confirm(msg)) void guard(() => removeAccount(a.id))
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

      {/* --------------------------------------------------- hesap bazlı kâr */}
      {active.length > 0 && (
        <Card
          title="Hesap Bazlı Kâr"
          actions={
            <select
              className="text-sm"
              value={profitScope}
              onChange={(e) => setProfitScope(e.target.value)}
            >
              <option value="">Tüm arzlar</option>
              {active.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          }
        >
          {byAccount.length === 0 ? (
            <Empty>
              {profitScope ? 'Bu arzda düşen lot yok.' : 'Henüz düşen lot yok.'}
            </Empty>
          ) : profitScope ? (
            /* Tek arz: o arzın lot/güncel fiyatıyla hesap kırılımı */
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px]">
                <thead>
                  <tr>
                    <th className="th">Hesap</th>
                    <th className="th text-right">Düşen lot</th>
                    <th className="th text-right">Lot fiyatı</th>
                    <th className="th text-right">Güncel fiyat</th>
                    <th className="th text-right">Toplam kâr</th>
                    <th className="th text-right">Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {byAccount.map((r) => (
                    <tr key={r.id} className="hover:bg-surface2/50">
                      <td className="td font-medium">{r.name}</td>
                      <td className="td text-right num">{formatNumber(r.lot, 0)}</td>
                      <td className="td text-right num text-muted">
                        {r.avgLotPrice != null ? formatTRY(r.avgLotPrice) : '—'}
                      </td>
                      <td className="td text-right num">
                        {r.avgPrice != null ? formatTRY(r.avgPrice) : '—'}
                      </td>
                      <td className="td text-right">
                        <div
                          className={`num font-semibold ${r.total >= 0 ? 'text-pos' : 'text-neg'}`}
                        >
                          {formatTRY(r.total)}
                          {r.pct != null && (
                            <span className="ml-1 text-xs font-normal">
                              {formatPercent(r.pct)}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted num">
                          gerçekleşen {formatTRY(r.realized)} · açık {formatTRY(r.open)}
                        </div>
                      </td>
                      <td className="td text-right num text-muted">
                        {formatTRY(balanceOf.get(r.id) ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* Tüm arzlar: hesap başına eldeki toplam değer + total kâr */
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr>
                    <th className="th">Hesap</th>
                    <th className="th text-right" title="Satılmamış arz hisselerinin güncel değeri">
                      Eldeki değer
                    </th>
                    <th className="th text-right">Toplam kâr</th>
                    <th className="th text-right">Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {byAccount.map((r) => (
                    <tr key={r.id} className="hover:bg-surface2/50">
                      <td className="td font-medium">{r.name}</td>
                      <td className="td text-right num font-medium">
                        {formatTRY(r.heldValue)}
                        <div className="text-xs text-muted font-normal">
                          {formatNumber(r.lot, 0)} lot düştü
                        </div>
                      </td>
                      <td className="td text-right">
                        <div
                          className={`num font-semibold ${r.total >= 0 ? 'text-pos' : 'text-neg'}`}
                        >
                          {formatTRY(r.total)}
                          {r.pct != null && (
                            <span className="ml-1 text-xs font-normal">
                              {formatPercent(r.pct)}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted num">
                          gerçekleşen {formatTRY(r.realized)} · açık {formatTRY(r.open)}
                        </div>
                      </td>
                      <td className="td text-right num text-muted">
                        {formatTRY(balanceOf.get(r.id) ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      </div>

      {/* --------------------------- arzlar: sol liste + sağ detay paneli */}
      {active.length === 0 ? (
        <Empty>{noAccounts ? 'Önce halka arz hesaplarını ekle.' : 'Henüz arz eklenmedi.'}</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12 items-start">
          {/* Sol: arz listesi */}
          <Card className="p-0 lg:col-span-4 overflow-hidden">
            <header className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-ink">Arz Listesi</h2>
              <Badge tone="accent">{active.length} arz</Badge>
            </header>
            <div className="divide-y divide-border max-h-[640px] overflow-y-auto">
              {active.map((ipo) => {
                const s = statsOf(ipo)
                const meta = stateMeta(ipo.status)
                const sel = selectedIpo?.id === ipo.id
                return (
                  <button
                    key={ipo.id}
                    onClick={() => setSelected(ipo.id)}
                    aria-current={sel ? 'true' : undefined}
                    className={`block w-full text-left px-4 py-3 transition-colors ${
                      sel ? 'bg-accent/10' : 'hover:bg-surface2/60'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`font-medium truncate ${sel ? 'text-accent' : ''}`}>
                            {ipo.name}
                          </span>
                          {ipo.bist_code && (
                            <span className="text-xs text-muted shrink-0">{ipo.bist_code}</span>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                          {/* Arz takviminden otomatik açılanlar ayırt edilsin */}
                          {ipo.source === 'takvim' && (
                            <span
                              className="text-[10px] text-muted"
                              title="Arz takviminden otomatik eklendi — hesap ve lot bilgisini sen gireceksin"
                            >
                              takvimden
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="num text-sm font-medium">{formatTRY(s.holding ?? s.cost)}</div>
                        {s.profit != null && s.profit !== 0 && (
                          <div className={`text-xs num ${s.profit >= 0 ? 'text-pos' : 'text-neg'}`}>
                            {s.profit >= 0 ? '+' : ''}
                            {formatTRY(s.profit)}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
            {cancelled.length > 0 && (
              <div className="border-t border-border px-4 py-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>İptal:</span>
                {cancelled.map((i) => (
                  <span
                    key={i.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface2 px-2.5 py-1"
                  >
                    {i.name}
                    <button
                      className="text-accent hover:underline"
                      onClick={() =>
                        void guard(() => updateIpo(i.id, { status: 'talep_verildi' }), true)
                      }
                    >
                      geri al
                    </button>
                    <button
                      className="text-neg hover:underline"
                      onClick={() => {
                        if (confirm(`"${i.name}" arzı kalıcı olarak silinsin mi?`)) {
                          void guard(() => removeIpo(i.id), true)
                        }
                      }}
                    >
                      sil
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* Sağ: seçili arzın detayı */}
          <Card className="lg:col-span-8">
            {!selectedIpo ? (
              <Empty>Soldan bir arz seç.</Empty>
            ) : (
              (() => {
                const ipo = selectedIpo
                const s = statsOf(ipo)
                const meta = stateMeta(ipo.status)
                const joined = entries.filter((e) => e.ipo_id === ipo.id && e.participated)
                const future = ipo.trade_start_date && ipo.trade_start_date > todayISO()
                return (
                  <>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-[220px]">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{ipo.name}</span>
                          {ipo.bist_code && (
                            <span className="text-xs text-muted">{ipo.bist_code}</span>
                          )}
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </div>
                        <div className="text-xs text-muted mt-0.5">
                          {ipo.ipo_date
                            ? format(parseISO(ipo.ipo_date), 'd MMM yyyy', { locale: tr })
                            : 'tarihsiz'}
                          {ipo.lot_price != null && ` · lot ${formatTRY(ipo.lot_price)}`}
                          {ipo.default_lot != null &&
                            ` · hesap başına ${formatNumber(ipo.default_lot, 0)} lot`}
                          {` · ${s.accountCount} hesap`}
                          {s.totalAllocated > 0 &&
                            ` · düşen ${formatNumber(s.totalAllocated, 0)} lot`}
                          {s.price != null && ` · güncel ${formatTRY(s.price)}`}
                        </div>
                        {future && (
                          <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                            {format(parseISO(ipo.trade_start_date as string), 'd MMMM', {
                              locale: tr,
                            })}{' '}
                            saat 10:01'de fiyat otomatik çekilecek
                          </div>
                        )}
                      </div>

                      <div className="text-right">
                        <div className="num font-semibold">{formatTRY(s.holding ?? s.cost)}</div>
                        {s.profit != null && s.profit !== 0 && (
                          <div className={`text-xs num ${s.profit >= 0 ? 'text-pos' : 'text-neg'}`}>
                            {s.profit >= 0 ? '+' : ''}
                            {formatTRY(s.profit)}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
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
                        <button
                          className="btn-ghost text-xs"
                          onClick={() => openAllocate(ipo)}
                          title="Düşen lotu düzelt"
                        >
                          Dağıtımı düzelt
                        </button>
                      )}
                      {ipo.bist_code && (
                        <button
                          className="btn-ghost text-xs"
                          disabled={refreshing}
                          onClick={() => void refreshWithAsset(ipo)}
                          title={`${ipo.bist_code} güncel fiyatını BIST'ten çek`}
                        >
                          {refreshing ? 'Çekiliyor…' : '↻ Fiyat çek'}
                        </button>
                      )}
                      <button
                        className={missingTalep(ipo) ? 'btn-primary text-xs' : 'btn-ghost text-xs'}
                        onClick={() => openFunding(ipo)}
                        title="Talebi hangi parayla verdin — hesaptaki parayla mı, kendi hesabından mı"
                      >
                        Talep karşılığı
                      </button>
                      <button className="btn-ghost text-xs" onClick={() => openIpoModal(ipo)}>
                        Düzenle
                      </button>
                      {ipo.status === 'talep_verildi' && (
                        <button
                          className="btn-ghost text-xs"
                          title="Arz iptal oldu — kayıt silinmez, listenin altında durur"
                          onClick={() => {
                            if (confirm(`"${ipo.name}" arzı iptal olarak işaretlensin mi?`)) {
                              void guard(() => updateIpo(ipo.id, { status: 'iptal' }), true)
                            }
                          }}
                        >
                          İptal et
                        </button>
                      )}
                      <button
                        className="btn-danger text-xs"
                        onClick={() => {
                          if (
                            confirm(
                              `"${ipo.name}" arzı, katılımları ve hesaplara yazılmış iade/satış hareketleri silinsin mi?`
                            )
                          ) {
                            void guard(() => removeIpo(ipo.id), true)
                          }
                        }}
                      >
                        Sil
                      </button>
                    </div>

                    <div className="mt-4 border-t border-border pt-3">
                      {(() => {
                        // Bu sürümden önce kutucukla işaretlenen hesaplarda bloke yazılmış
                        // ama karşılığı sorulmamıştı; kayıtlı parası olmayan hesap eksiye
                        // düştü. Tek tıkla düzelir: açık, açılış bakiyesi olarak yazılır.
                        const negatives = joined
                          .map((e) => accounts.find((a) => a.id === e.account_id)?.name ?? '—')
                          .filter((_, i) => (balanceOf.get(joined[i].account_id) ?? 0) < -0.005)
                        if (!negatives.length) return null
                        return (
                          <div className="mb-3 rounded-lg border border-neg/30 bg-neg/10 px-3 py-2 text-xs text-neg">
                            {negatives.join(', ')} eksi bakiyede — talep blokesi hesaptaki kayıtlı parayı
                            aşıyor, karşılığı yazılmamış.
                            <button
                              type="button"
                              className="ml-1 underline underline-offset-2 hover:no-underline"
                              onClick={() => openFunding(ipo)}
                            >
                              Düzelt
                            </button>{' '}
                            — açık, açılış bakiyesi olarak yazılır (para hesapta vardı, kayda geçmemişti);
                            parayı kendi hesabından attıysan orada "kendi hesabımdan"ı seç.
                          </div>
                        )
                      })()}
                      {missingTalep(ipo) && (
                        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                          Bu arzda hesaplardan bloke edilen para deftere yazılmamış — yalnızca iade
                          yazıldığı için hesap bakiyeleri {formatTRY(s.refund)} kadar fazla görünüyor.
                          <button
                            type="button"
                            className="ml-1 underline underline-offset-2 hover:no-underline"
                            onClick={() => openFunding(ipo)}
                          >
                            Talep karşılığını gir
                          </button>{' '}
                          — parayı hesaptaki bakiyeden mi verdin, kendi hesabından mı attın, orada
                          seçeceksin.
                        </div>
                      )}
                      {noAccounts ? (
                        <Empty>Halka arz hesabı yok.</Empty>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead>
                              <tr>
                                <th className="th">Hesap</th>
                                <th className="th text-right" title="İstenen → düşen lot">
                                  İst → Düşen
                                </th>
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
                                const refund = Math.max(req - alloc, 0) * lot
                                const realized = sold * ((soldPrice ?? 0) - lot)
                                const openProfit =
                                  price != null ? Math.max(alloc - sold, 0) * (price - lot) : 0
                                const profit = realized + openProfit
                                return (
                                  <tr key={a.id} className={isIn ? '' : 'opacity-50'}>
                                    <td className="td">
                                      <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          className="w-4 h-4"
                                          checked={isIn}
                                          disabled={!user || busy}
                                          onChange={(ev) =>
                                            void guard(async () => {
                                              await toggleEntry(ipo, a.id, ev.target.checked, user!.id)
                                              // Dağıtım yapıldıysa iadeler de tazelenir —
                                              // katılımdan çıkan hesabın eski iadesi bakiyede kalmasın
                                              if (ipo.status !== 'talep_verildi') {
                                                const iadeDate =
                                                  ledger.find(
                                                    (l) => l.ipo_id === ipo.id && l.kind === 'iade'
                                                  )?.date ?? todayISO()
                                                await settleDistribution(ipo, iadeDate)
                                              }
                                            }, true)
                                          }
                                        />
                                        <span className="font-medium">{a.name}</span>
                                      </label>
                                    </td>
                                    <td className="td text-right num whitespace-nowrap">
                                      {req ? formatNumber(req, 0) : '—'}
                                      <span className="text-muted mx-1">→</span>
                                      {alloc ? formatNumber(alloc, 0) : '—'}
                                    </td>
                                    <td className="td text-right num">
                                      {isIn && refund > 0 ? (
                                        <span className="text-pos">{formatTRY(refund)}</span>
                                      ) : (
                                        <span className="text-muted">—</span>
                                      )}
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
                                    <td
                                      className={`td text-right num ${
                                        profit >= 0 ? 'text-pos' : 'text-neg'
                                      }`}
                                    >
                                      {alloc > 0 ? formatTRY(profit) : '—'}
                                    </td>
                                    <td className="td text-right whitespace-nowrap">
                                      {isIn &&
                                        alloc > 0 &&
                                        (sold > 0 ? (
                                          <button
                                            className="btn-ghost text-xs"
                                            onClick={() =>
                                              void guard(() => unsellEntries(ipo, [e!.id]), true)
                                            }
                                          >
                                            Satışı geri al
                                          </button>
                                        ) : (
                                          <button
                                            className="btn-ghost text-xs"
                                            onClick={() => openSale(ipo, e!)}
                                          >
                                            Sat
                                          </button>
                                        ))}
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
                        {(() => {
                          const blocked = blockedOf.get(ipo.id) ?? 0
                          if (blocked <= 0.005 || ipo.status !== 'talep_verildi') return null
                          return (
                            <span className="text-amber-600 dark:text-amber-400">
                              Bloke: {formatTRY(blocked)}
                            </span>
                          )
                        })()}
                        {s.refund > 0 && (
                          <span className="text-pos">İade: {formatTRY(s.refund)}</span>
                        )}
                        {s.proceeds > 0 && <span>Satış geliri: {formatTRY(s.proceeds)}</span>}
                      </div>
                      {joined.length === 0 && (
                        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                          Hiçbir hesap işaretli değil — katıldığın hesapların kutusunu işaretle,
                          hesap başına {formatNumber(ipo.default_lot ?? 0, 0)} lot otomatik yazılır.
                        </p>
                      )}
                    </div>
                  </>
                )
              })()
            )}
          </Card>
        </div>
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

      </>
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
                <input
                  name="name"
                  className="w-full"
                  defaultValue={modal.ipo?.name ?? modal.prefill?.name ?? ''}
                  autoFocus
                  required
                />
              </div>
              <div>
                <label className="label">BIST kodu</label>
                <input
                  name="bist_code"
                  className="w-full uppercase"
                  placeholder="ABCDE"
                  defaultValue={modal.ipo?.bist_code ?? modal.prefill?.bist_code ?? ''}
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

      <Modal open={modal?.type === 'funding'} title="Talep Karşılığı" onClose={() => setModal(null)}>
        {modal?.type === 'funding' &&
          (() => {
            const ipo = modal.ipo
            const needs = modal.needs
            const short = shortNeeds(needs)
            const sum = (list: AccountNeed[], pick: (n: AccountNeed) => number) =>
              list.reduce((acc, n) => acc + pick(n), 0)
            const required = sum(needs, (n) => n.required)
            const gap = sum(short, (n) => n.shortfall)
            const bySource = (src: FundingSource) =>
              sum(
                short.filter((n) => (fundChoices[n.accountId]?.source ?? 'mevcut') === src),
                (n) => n.shortfall
              )
            const fromOwn = bySource('aktar')
            const fromOutside = bySource('disari')
            const fromOpening = bySource('mevcut')

            return (
              <form onSubmit={submitFunding} className="space-y-3">
                {formError && <ErrorBox message={formError} />}

                <p className="text-sm text-muted">
                  <span className="text-ink font-medium">{ipo.name}</span> talebi verilirken
                  hesaplardan toplam <span className="num text-ink">{formatTRY(required)}</span> bloke
                  edildi. Bu para nereden geldi?
                </p>

                <div>
                  <label className="label">Talep tarihi</label>
                  <input
                    type="date"
                    className="w-full"
                    value={moveDate}
                    onChange={(ev) => setMoveDate(ev.target.value)}
                  />
                </div>

                {short.length === 0 ? (
                  <div className="rounded-lg border border-border bg-surface2 px-3 py-2 text-xs text-muted">
                    Bütün hesaplarda talebi karşılayacak para zaten duruyordu — bloke dışında yeni bir
                    para hareketi yazılmayacak, toplam varlığın değişmeyecek.
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted">
                      {short.length} hesapta toplam{' '}
                      <span className="num text-amber-600 dark:text-amber-400">{formatTRY(gap)}</span>{' '}
                      açık var — hepsi için:
                    </span>
                    {(['mevcut', 'aktar', 'disari'] as FundingSource[]).map((src) => (
                      <button
                        key={src}
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => applyFundingToAll(needs, src)}
                      >
                        {FUNDING_LABELS[src]}
                      </button>
                    ))}
                  </div>
                )}

                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[520px]">
                    <thead>
                      <tr>
                        <th className="th">Hesap</th>
                        <th className="th text-right">Gereken</th>
                        <th className="th text-right" title="Talep blokesi öncesi bakiye">
                          Hesapta
                        </th>
                        <th className="th text-right">Açık</th>
                        <th className="th">Karşılık</th>
                      </tr>
                    </thead>
                    <tbody>
                      {needs.map((n) => {
                        const choice = fundChoices[n.accountId] ?? { source: 'mevcut' as FundingSource }
                        return (
                          <tr key={n.accountId}>
                            <td className="td font-medium">{n.accountName}</td>
                            <td className="td text-right num">{formatTRY(n.required)}</td>
                            <td className="td text-right num text-muted">{formatTRY(n.available)}</td>
                            <td className="td text-right num">
                              {n.shortfall > 0 ? (
                                <span className="text-amber-600 dark:text-amber-400">
                                  {formatTRY(n.shortfall)}
                                </span>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                            <td className="td">
                              {n.shortfall === 0 ? (
                                <span className="text-xs text-muted">Hesaptaki parayla</span>
                              ) : (
                                <div className="flex flex-wrap items-center gap-1">
                                  <select
                                    className="text-xs"
                                    value={choice.source}
                                    onChange={(ev) =>
                                      setFundChoice(n.accountId, {
                                        source: ev.target.value as FundingSource,
                                      })
                                    }
                                  >
                                    {(['mevcut', 'aktar', 'disari'] as FundingSource[]).map((src) => (
                                      <option key={src} value={src}>
                                        {FUNDING_LABELS[src]}
                                      </option>
                                    ))}
                                  </select>
                                  {choice.source === 'mevcut' && (
                                    <span
                                      className="text-[11px] text-muted"
                                      title="Para hesapta vardı ama defterde yoktu — açık, açılış bakiyesi olarak yazılır"
                                    >
                                      açılış bakiyesi yazılır
                                    </span>
                                  )}
                                  {choice.source === 'aktar' && (
                                    <select
                                      className="text-xs"
                                      value={choice.fromAccountId ?? ''}
                                      onChange={(ev) =>
                                        setFundChoice(n.accountId, {
                                          fromAccountId: ev.target.value || null,
                                        })
                                      }
                                    >
                                      <option value="">Hangi hesaptan?</option>
                                      {ownAccounts.map((a) => (
                                        <option key={a.id} value={a.id}>
                                          {a.name} · {formatTRY(balanceOf.get(a.id) ?? 0)}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-lg bg-surface2 px-3 py-2 text-sm space-y-0.5">
                  <div className="flex justify-between">
                    <span className="text-muted">Hesaplardan bloke edilen</span>
                    <span className="num">{formatTRY(required)}</span>
                  </div>
                  {fromOpening > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted">Hesapta zaten duran (kayıt dışı) · açılış bakiyesi</span>
                      <span className="num text-pos">+{formatTRY(fromOpening)}</span>
                    </div>
                  )}
                  {fromOwn > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted">Kendi hesabından aktarılan</span>
                      <span className="num">{formatTRY(fromOwn)}</span>
                    </div>
                  )}
                  {fromOutside > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted">Dışarıdan yatan · toplam varlığı artırır</span>
                      <span className="num text-pos">+{formatTRY(fromOutside)}</span>
                    </div>
                  )}
                </div>

                <p className="text-xs text-muted">
                  Bloke, dağıtım açıklanana kadar hesap bakiyesinden düşük görünür ama kaybolmaz —
                  Dashboard'da "arzda bloke" olarak toplam varlığına sayılır. Dağıtım açıklanınca
                  düşmeyen lotun parası iade olarak geri yazılır; hesapta yalnızca düşen lotun
                  maliyeti kalır. Hesap hiçbir zaman eksiye düşmez: kayıtlı para yetmiyorsa fark
                  açılış bakiyesi olarak yazılır, kaynağını buradan değiştirebilirsin.
                </p>

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                    Vazgeç
                  </button>
                  <button className="btn-primary" disabled={busy}>
                    {busy ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                </div>
              </form>
            )
          })()}
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
                      <label className="text-xs text-muted">istenen</label>
                      <input
                        className="w-20 num text-right"
                        inputMode="decimal"
                        value={reqMap[e.account_id] ?? ''}
                        onChange={(ev) => setReqMap({ ...reqMap, [e.account_id]: ev.target.value })}
                      />
                      <label className="text-xs text-muted">düşen</label>
                      <input
                        className="w-20 num text-right"
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
