import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useAccounts } from '../hooks/useAccounts'
import { useAssets } from '../hooks/useAssets'
import { useIpos, ipoStats } from '../hooks/useIpos'
import { usePrices } from '../hooks/usePrices'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatTRY, parseAmount } from '../lib/currency'
import { todayISO } from '../lib/calc'
import type { IpoRow, IpoState } from '../types/db'

const STATES: { value: IpoState; label: string; tone: string }[] = [
  { value: 'talep_verildi', label: 'Talep Verildi', tone: 'warn' },
  { value: 'dagitildi', label: 'Dağıtıldı', tone: 'accent' },
  { value: 'islemde', label: 'Satışa Başladı', tone: 'accent' },
  { value: 'satildi', label: 'Satıldı', tone: 'pos' },
  { value: 'iptal', label: 'İptal', tone: 'muted' },
]
const stateMeta = (s: IpoState) => STATES.find((x) => x.value === s) ?? STATES[0]

type ModalState =
  | { type: 'ipo'; ipo: IpoRow | null }
  | { type: 'allocate'; ipo: IpoRow }
  | { type: 'sale'; ipo: IpoRow }
  | { type: 'transfer'; accountId: string; max: number }
  | null

/** Aktarım hedefi olarak "dışarı" seçildiğinde kullanılan sabit. */
const EXTERNAL = '__disari__'

export default function IpoPage() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  const effectiveScope = scope || user?.id || ''
  const isOwn = effectiveScope === user?.id

  const { accounts } = useAccounts(effectiveScope)
  const { ensureAsset } = useAssets()
  const { bySymbol, refresh: refreshPrices, refreshing } = usePrices()
  const {
    ipos, entries, ledger, balanceOf, totalWaiting, loading, error,
    createIpo, updateIpo, removeIpo, setEntry, applyAllocation,
    settleDistribution, settleSale, transfer,
  } = useIpos(effectiveScope)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activeAccounts = useMemo(() => accounts.filter((a) => a.is_active), [accounts])

  /** Güncel fiyat: elle girilen kazanır, yoksa BIST kodundan otomatik gelen. */
  const priceOf = (ipo: IpoRow): number | null => {
    if (ipo.manual_price != null) return Number(ipo.manual_price)
    const code = ipo.bist_code?.trim().toUpperCase()
    const p = code ? bySymbol.get(code) : undefined
    return p ? Number(p.price) : null
  }

  const statsOf = (ipo: IpoRow) => {
    const price = priceOf(ipo)
    return { ...ipoStats(ipo, entries, price), price }
  }

  // Elde tutulan hisselerin güncel değeri (satılmamış arzlar)
  const heldValue = useMemo(
    () =>
      ipos
        .filter((i) => i.status === 'dagitildi' || i.status === 'islemde')
        .reduce((s, i) => s + (statsOf(i).holding ?? statsOf(i).cost), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ipos, entries, bySymbol]
  )

  const realizedProfit = useMemo(
    () =>
      ipos
        .filter((i) => i.status === 'satildi')
        .reduce((s, i) => s + (statsOf(i).profit ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ipos, entries]
  )

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    setFormError(null)
    try {
      await fn()
      setModal(null)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------- arz kaydı
  const submitIpo = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
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
      manual_price: num('manual_price'),
      note: String(fd.get('note') ?? '').trim() || null,
    }
    if (!values.name) {
      setFormError('Arz adı gerekli.')
      return
    }
    const editing = modal?.type === 'ipo' ? modal.ipo : null

    const status = String(fd.get('status') ?? '') as IpoState

    void guard(async () => {
      if (editing) await updateIpo(editing.id, status ? { ...values, status } : values)
      else await createIpo({ ...values, user_id: user.id, status: 'talep_verildi' })
      // Borsa kodu varsa varlık kataloğuna ekle — fiyat otomasyonu buradan çeker
      if (code) {
        try {
          await ensureAsset(code, 'hisse', user.id, values.name)
        } catch {
          // katalog hatası arz kaydını engellemesin
        }
      }
    })
  }

  // ------------------------------------------------------------- durum akışı
  const markDistributed = (ipo: IpoRow, lot: number, date: string) =>
    guard(async () => {
      await applyAllocation(ipo.id, lot)
      await updateIpo(ipo.id, { status: 'dagitildi' })
      // applyAllocation sonrası entries tazelendiği için dağıtımı ayrı okuyoruz
      const fresh = { ...ipo, status: 'dagitildi' as IpoState }
      await settleDistribution(fresh, date)
    })

  const markTrading = (ipo: IpoRow) => guard(() => updateIpo(ipo.id, { status: 'islemde' }))

  const markSold = (ipo: IpoRow, price: number, date: string) =>
    guard(async () => {
      await updateIpo(ipo.id, { status: 'satildi', sold_price: price, sold_date: date })
      await settleSale({ ...ipo, sold_price: price }, price, date)
    })

  if (loading) return <Spinner />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Halka Arz"
        subtitle="Hesap bazlı talep, dağıtım, satış ve hesaplarda bekleyen para"
        actions={
          isOwn && (
            <button className="btn-primary" onClick={() => { setFormError(null); setModal({ type: 'ipo', ipo: null }) }}>
              + Arz Ekle
            </button>
          )
        }
      />

      <UserTabs profiles={profiles} currentUserId={user?.id} value={effectiveScope} onChange={setScope} />

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Hesaplarda Bekleyen" value={totalWaiting} hint="Çekilmeyi bekleyen nakit" />
        <StatCard title="Elde Tutulan Hisse" value={heldValue} hint="Güncel fiyatla" />
        <StatCard
          title="Gerçekleşen Kâr"
          value={realizedProfit}
          tone={realizedProfit >= 0 ? 'pos' : 'neg'}
          hint="Satılan arzlardan"
        />
        <StatCard
          title="Arz Sayısı"
          value={String(ipos.filter((i) => i.status !== 'iptal').length)}
          hint={`${activeAccounts.length} hesap tanımlı`}
        />
      </div>

      {/* ------------------------------------------------- hesap bakiyeleri */}
      <Card title="Hesap Bakiyeleri" actions={<span className="text-xs text-muted">Toplam {formatTRY(totalWaiting)}</span>}>
        {activeAccounts.length === 0 ? (
          <Empty>Önce Hesaplar sayfasından hesaplarını ekle.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Hesap</th>
                  <th className="th text-right">Bakiye</th>
                  <th className="th">Son hareket</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {activeAccounts.map((a) => {
                  const bal = balanceOf.get(a.id) ?? 0
                  const last = ledger.find((l) => l.account_id === a.id)
                  return (
                    <tr key={a.id}>
                      <td className="td">{a.name}</td>
                      <td className={`td text-right num ${bal > 0 ? 'text-pos' : 'text-muted'}`}>{formatTRY(bal)}</td>
                      <td className="td text-xs text-muted">{last ? `${last.note ?? last.kind} · ${last.date}` : '—'}</td>
                      <td className="td text-right">
                        {isOwn && bal > 0 && (
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => { setFormError(null); setModal({ type: 'transfer', accountId: a.id, max: bal }) }}
                          >
                            Para aktar
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------ arzlar */}
      {ipos.length === 0 ? (
        <Empty>Henüz arz eklenmedi.</Empty>
      ) : (
        ipos.map((ipo) => {
          const s = statsOf(ipo)
          const meta = stateMeta(ipo.status)
          const open = expanded === ipo.id
          return (
            <Card key={ipo.id}>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="text-left flex-1 min-w-[200px]"
                  onClick={() => setExpanded(open ? null : ipo.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{ipo.name}</span>
                    {ipo.bist_code && <span className="text-xs text-muted">{ipo.bist_code}</span>}
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </div>
                  <div className="text-xs text-muted mt-0.5">
                    {ipo.ipo_date ? format(parseISO(ipo.ipo_date), 'd MMM yyyy', { locale: tr }) : 'tarihsiz'}
                    {ipo.lot_price != null && ` · lot ${formatTRY(ipo.lot_price)}`}
                    {` · ${s.accountCount} hesap · ${formatNumber(s.totalAllocated, 0)} lot`}
                    {s.price != null && ` · güncel ${formatTRY(s.price)}`}
                  </div>
                </button>

                <div className="text-right">
                  <div className="num font-semibold">{formatTRY(s.holding ?? s.cost)}</div>
                  {s.profit != null && (
                    <div className={`text-xs num ${s.profit >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {s.profit >= 0 ? '+' : ''}{formatTRY(s.profit)}
                    </div>
                  )}
                </div>

                {isOwn && (
                  <div className="flex flex-wrap gap-2">
                    {ipo.status === 'talep_verildi' && (
                      <button className="btn-ghost text-xs" onClick={() => { setFormError(null); setModal({ type: 'allocate', ipo }) }}>
                        Dağıtıldı
                      </button>
                    )}
                    {ipo.status === 'dagitildi' && (
                      <button className="btn-ghost text-xs" onClick={() => void markTrading(ipo)}>
                        Satışa başladı
                      </button>
                    )}
                    {ipo.status === 'islemde' && (
                      <button className="btn-primary text-xs" onClick={() => { setFormError(null); setModal({ type: 'sale', ipo }) }}>
                        Tutarı çek (sat)
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
                    <button className="btn-ghost text-xs" onClick={() => { setFormError(null); setModal({ type: 'ipo', ipo }) }}>
                      Düzenle
                    </button>
                  </div>
                )}
              </div>

              {open && (
                <div className="mt-4 border-t border-border pt-3">
                  {activeAccounts.length === 0 ? (
                    <Empty>Hesap yok.</Empty>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr>
                            <th className="th">Katıldım</th>
                            <th className="th">Hesap</th>
                            <th className="th text-right">İstenen lot</th>
                            <th className="th text-right">Düşen lot</th>
                            <th className="th text-right">Talep tutarı</th>
                            <th className="th text-right">Maliyet</th>
                            <th className="th text-right">İade</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeAccounts.map((a) => {
                            const e = entries.find((x) => x.ipo_id === ipo.id && x.account_id === a.id)
                            const req = Number(e?.requested_lot ?? 0)
                            const alloc = Number(e?.allocated_lot ?? 0)
                            const lot = Number(ipo.lot_price ?? 0)
                            const joined = Boolean(e?.participated)
                            return (
                              <tr key={a.id} className={joined ? '' : 'opacity-60'}>
                                <td className="td">
                                  <input
                                    type="checkbox"
                                    checked={joined}
                                    disabled={!isOwn || !user}
                                    onChange={(ev) =>
                                      void setEntry(ipo.id, a.id, user!.id, { participated: ev.target.checked })
                                    }
                                  />
                                </td>
                                <td className="td">{a.name}</td>
                                <td className="td text-right">
                                  <input
                                    className="w-20 num text-right"
                                    inputMode="decimal"
                                    defaultValue={req || ''}
                                    disabled={!isOwn || !user}
                                    onBlur={(ev) => {
                                      const v = parseAmount(ev.target.value)
                                      if (v !== req) void setEntry(ipo.id, a.id, user!.id, { requested_lot: v })
                                    }}
                                  />
                                </td>
                                <td className="td text-right">
                                  <input
                                    className="w-20 num text-right"
                                    inputMode="decimal"
                                    defaultValue={alloc || ''}
                                    disabled={!isOwn || !user || ipo.status === 'talep_verildi'}
                                    onBlur={(ev) => {
                                      const v = parseAmount(ev.target.value)
                                      if (v !== alloc) void setEntry(ipo.id, a.id, user!.id, { allocated_lot: v })
                                    }}
                                  />
                                </td>
                                <td className="td text-right num text-muted">{formatTRY(req * lot)}</td>
                                <td className="td text-right num">{formatTRY(alloc * lot)}</td>
                                <td className="td text-right num text-pos">
                                  {formatTRY(Math.max(req - alloc, 0) * lot)}
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
                    <span>Toplam istenen: {formatNumber(s.totalRequested, 0)} lot</span>
                    <span>Toplam düşen: {formatNumber(s.totalAllocated, 0)} lot</span>
                    <span>Maliyet: {formatTRY(s.cost)}</span>
                    {ipo.status === 'satildi' && ipo.sold_price != null && (
                      <span>Satış: {formatTRY(ipo.sold_price)} / lot</span>
                    )}
                    {isOwn && (
                      <button
                        className="btn-danger text-xs ml-auto"
                        onClick={() => {
                          if (confirm(`"${ipo.name}" arzı ve tüm kayıtları silinsin mi?`)) void removeIpo(ipo.id)
                        }}
                      >
                        Sil
                      </button>
                    )}
                  </div>
                </div>
              )}
            </Card>
          )
        })
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
                <input name="name" className="w-full" defaultValue={modal.ipo?.name ?? ''} autoFocus />
              </div>
              <div>
                <label className="label">BIST kodu (fiyat otomasyonu)</label>
                <input name="bist_code" className="w-full uppercase" placeholder="ABCDE" defaultValue={modal.ipo?.bist_code ?? ''} />
              </div>
              <div>
                <label className="label">Arz tarihi</label>
                <input type="date" name="ipo_date" className="w-full" defaultValue={modal.ipo?.ipo_date ?? todayISO()} />
              </div>
              <div>
                <label className="label">Lot fiyatı (halka arz)</label>
                <input name="lot_price" className="w-full num" inputMode="decimal" defaultValue={modal.ipo?.lot_price ?? ''} />
              </div>
              <div>
                <label className="label">Güncel fiyat (elle ez)</label>
                <input name="manual_price" className="w-full num" inputMode="decimal" defaultValue={modal.ipo?.manual_price ?? ''} placeholder="boşsa otomatik" />
              </div>
              {modal.ipo && (
                <div className="sm:col-span-2">
                  <label className="label">
                    Durum — elle değiştirirsen para hareketleri yeniden yazılmaz
                  </label>
                  <select name="status" className="w-full" defaultValue={modal.ipo.status}>
                    {STATES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="sm:col-span-2">
                <label className="label">Not</label>
                <input name="note" className="w-full" defaultValue={modal.ipo?.note ?? ''} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'allocate'} title="Dağıtım Sonucu" onClose={() => setModal(null)}>
        {modal?.type === 'allocate' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              void markDistributed(modal.ipo, parseAmount(String(fd.get('lot') ?? '')), String(fd.get('date') ?? todayISO()))
            }}
            className="space-y-3"
          >
            {formError && <ErrorBox message={formError} />}
            <p className="text-sm text-muted">
              Katıldığın hesaplara düşen lot sayısını yaz. Hepsine uygulanır; farklı olan hesabı
              tablodan tek tek düzeltebilirsin. Kalan tutar hesaplara iade olarak yazılır.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Hesap başına düşen lot</label>
                <input name="lot" className="w-full num" inputMode="decimal" autoFocus defaultValue="1" />
              </div>
              <div>
                <label className="label">Dağıtım tarihi</label>
                <input type="date" name="date" className="w-full" defaultValue={todayISO()} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'İşleniyor…' : 'Dağıtıldı olarak işaretle'}</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'sale'} title="Satış" onClose={() => setModal(null)}>
        {modal?.type === 'sale' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              void markSold(modal.ipo, parseAmount(String(fd.get('price') ?? '')), String(fd.get('date') ?? todayISO()))
            }}
            className="space-y-3"
          >
            {formError && <ErrorBox message={formError} />}
            <p className="text-sm text-muted">
              Satış tutarı, hisseyi aldığın hesaplara lot oranında yatırılır. Oradan "Para aktar" ile
              kendi hesabına çekersin.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Satış fiyatı (1 lot)</label>
                <input
                  name="price"
                  className="w-full num"
                  inputMode="decimal"
                  autoFocus
                  defaultValue={priceOf(modal.ipo) ?? ''}
                />
              </div>
              <div>
                <label className="label">Satış tarihi</label>
                <input type="date" name="date" className="w-full" defaultValue={todayISO()} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
              <button className="btn-primary" disabled={busy}>{busy ? 'İşleniyor…' : 'Sattım'}</button>
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
              Başka bir hesabına aktarırsan para sende kalır, toplam varlığın değişmez.
              "Dışarı" seçersen para sistemden çıkar ve toplamdan düşer.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Nereye?</label>
                <select name="to" className="w-full" defaultValue="" required>
                  <option value="" disabled>Hedef seç…</option>
                  {activeAccounts
                    .filter((a) => a.id !== modal.accountId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
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
