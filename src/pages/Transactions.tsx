import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAuth } from '../hooks/useAuth'
import { useAccounts } from '../hooks/useAccounts'
import { useChartColors } from '../hooks/useTheme'
import { useTable } from '../hooks/useTable'
import { supabase } from '../lib/supabase'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatCompactTRY, formatTRY, parseAmount } from '../lib/currency'
import { colorAt, todayISO } from '../lib/calc'
import type { Currency, Receivable, Transaction, TxCategory, TxDirection } from '../types/db'

const CATEGORIES: { value: TxCategory; label: string }[] = [
  { value: 'fatura', label: 'Fatura' },
  { value: 'seyahat', label: 'Seyahat' },
  { value: 'market', label: 'Market' },
  { value: 'kira', label: 'Kira' },
  { value: 'maas', label: 'Maaş' },
  { value: 'kk_odeme', label: 'KK Ödemesi' },
  { value: 'diger', label: 'Diğer' },
]

const catLabel = (c: TxCategory) => CATEGORIES.find((x) => x.value === c)?.label ?? c

/** Form üç iş yapar: gelir, gider ve birine borç verme. */
type EntryKind = TxDirection | 'borc'

type ModalState =
  | { type: 'entry'; row: Transaction | null }
  | { type: 'collect'; row: Receivable }
  | null

export default function Transactions() {
  const cc = useChartColors()
  const { user } = useAuth()
  const userId = user?.id ?? ''

  const { accounts } = useAccounts(userId)
  const { rows, loading, error, insert, update, remove } = useTable<Transaction>('transactions', {
    userId,
    orderBy: 'date',
    ascending: false,
  })
  const {
    rows: lendings,
    reload: reloadLendings,
    remove: removeLending,
  } = useTable<Receivable>('receivables', { userId, orderBy: 'given_date', ascending: false })

  const [modal, setModal] = useState<ModalState>(null)
  const [kind, setKind] = useState<EntryKind>('gider')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [catFilter, setCatFilter] = useState<'' | TxCategory>('')
  const [dirFilter, setDirFilter] = useState<'' | TxDirection>('')

  /** Halka arz hesapları bu sayfaya girmez — onlar Halka Arz sayfasının işi */
  const ownAccounts = useMemo(
    () => accounts.filter((a) => !a.is_ipo && a.is_active),
    [accounts]
  )
  const accountName = (id: string | null) =>
    id ? (accounts.find((a) => a.id === id)?.name ?? '—') : '—'

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) => (!catFilter || r.category === catFilter) && (!dirFilter || r.direction === dirFilter)
      ),
    [rows, catFilter, dirFilter]
  )

  const totals = useMemo(() => {
    let gelir = 0
    let gider = 0
    for (const r of filtered) {
      const v = Number(r.amount) * Number(r.fx_rate ?? 1)
      if (r.direction === 'gelir') gelir += v
      else gider += v
    }
    return { gelir, gider, net: gelir - gider }
  }, [filtered])

  const openLending = useMemo(
    () =>
      lendings
        .filter((r) => !r.is_collected)
        .reduce((s, r) => s + Number(r.amount) * Number(r.fx_rate ?? 1), 0),
    [lendings]
  )

  // Aylık kategori bazlı gider grafiği
  const { chartData, chartCats } = useMemo(() => {
    const map = new Map<string, Record<string, number>>()
    const cats = new Set<string>()
    for (const r of rows) {
      if (r.direction !== 'gider') continue
      const month = r.date.slice(0, 7)
      const entry = map.get(month) ?? {}
      const label = catLabel(r.category)
      entry[label] = (entry[label] ?? 0) + Number(r.amount) * Number(r.fx_rate ?? 1)
      map.set(month, entry)
      cats.add(label)
    }
    const data = [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([month, values]) => ({ month, ...values }))
    return { chartData: data, chartCats: [...cats] }
  }, [rows])

  const editing = modal?.type === 'entry' ? modal.row : null

  const openEntry = (row: Transaction | null) => {
    setFormError(null)
    setKind(row?.direction ?? 'gider')
    setModal({ type: 'entry', row })
  }

  // ------------------------------------------------------------- borç
  /**
   * Borç verme parayı gerçekten hareket ettirir: alacak kaydı açılır ve
   * seçilen hesabın bakiyesinden tutar düşülür. Tahsilat da aynı defteri
   * artı yönde besler; böylece "kimden alacağım var" ile "hesabımda ne
   * kadar para var" tek yerden tutarlı kalır.
   */
  const lend = async (values: {
    person: string
    amount: number
    currency: Currency
    fx_rate: number
    given_date: string
    expected_date: string | null
    account_id: string | null
    note: string | null
  }) => {
    if (!user) throw new Error('Oturum bulunamadı.')
    if (!values.person) throw new Error('Kime verdiğini yaz.')
    if (!(values.amount > 0)) throw new Error('Tutar sıfırdan büyük olmalı.')
    if (!values.account_id) throw new Error('Parayı hangi hesaptan verdiğini seç.')

    const { data, error: insErr } = await supabase
      .from('receivables')
      .insert({ user_id: user.id, is_collected: false, ...values })
      .select()
      .single()
    if (insErr) throw new Error(insErr.message)

    const { error: ledErr } = await supabase.from('account_ledger').insert({
      user_id: user.id,
      account_id: values.account_id,
      receivable_id: (data as Receivable).id,
      kind: 'borc',
      amount: -Math.abs(values.amount * values.fx_rate),
      date: values.given_date,
      note: `${values.person} — borç verildi`,
    })
    if (ledErr) throw new Error(ledErr.message)
    await reloadLendings()
  }

  const collect = async (r: Receivable, accountId: string, date: string, amount: number) => {
    if (!user) throw new Error('Oturum bulunamadı.')
    if (!accountId) throw new Error('Paranın yattığı hesabı seç.')
    if (!(amount > 0)) throw new Error('Tutar sıfırdan büyük olmalı.')

    const { error: upErr } = await supabase
      .from('receivables')
      .update({ is_collected: true, collected_date: date, collected_account_id: accountId })
      .eq('id', r.id)
    if (upErr) throw new Error(upErr.message)

    const { error: ledErr } = await supabase.from('account_ledger').insert({
      user_id: user.id,
      account_id: accountId,
      receivable_id: r.id,
      kind: 'tahsil',
      amount: Math.abs(amount),
      date,
      note: `${r.person} — borç tahsil edildi`,
    })
    if (ledErr) throw new Error(ledErr.message)
    await reloadLendings()
  }

  /** Yanlış işaretlendiyse tahsilatı geri alır; para hesaptan yine çıkar. */
  const uncollect = async (r: Receivable) => {
    const { error: delErr } = await supabase
      .from('account_ledger')
      .delete()
      .eq('receivable_id', r.id)
      .eq('kind', 'tahsil')
    if (delErr) throw new Error(delErr.message)
    const { error } = await supabase
      .from('receivables')
      .update({ is_collected: false, collected_date: null, collected_account_id: null })
      .eq('id', r.id)
    if (error) throw new Error(error.message)
    await reloadLendings()
  }

  const guard = async (fn: () => Promise<unknown>, close = true) => {
    setBusy(true)
    setFormError(null)
    try {
      await fn()
      if (close) setModal(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------ kayıt
  const submitEntry = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const amount = parseAmount(String(fd.get('amount') ?? ''))
    const currency = String(fd.get('currency') ?? 'TRY') as Currency
    const fx_rate = parseAmount(String(fd.get('fx_rate') ?? '1')) || 1
    const date = String(fd.get('date') ?? todayISO())
    const account_id = String(fd.get('account_id') ?? '') || null
    const note = String(fd.get('note') ?? '').trim() || null
    const title = String(fd.get('title') ?? '').trim()

    if (kind === 'borc') {
      void guard(() =>
        lend({
          person: title,
          amount,
          currency,
          fx_rate,
          given_date: date,
          expected_date: String(fd.get('expected_date') ?? '') || null,
          account_id,
          note,
        })
      )
      return
    }

    const values = {
      user_id: user.id,
      account_id,
      date,
      direction: kind as TxDirection,
      category: String(fd.get('category') ?? 'diger') as TxCategory,
      title,
      amount,
      currency,
      fx_rate,
      note,
    }
    if (!values.title) return setFormError('Başlık gerekli.')
    void guard(async () => {
      if (editing) await update(editing.id, values)
      else await insert(values)
    })
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Gelir / Gider"
        subtitle="Nakit akışın ve verdiğin borçlar."
        actions={
          <button className="btn-primary" onClick={() => openEntry(null)}>
            + Kayıt ekle
          </button>
        }
      />

      {error && <ErrorBox message={error} />}
      {formError && !modal && <ErrorBox message={formError} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Toplam Gelir" value={totals.gelir} tone="pos" />
        <StatCard title="Toplam Gider" value={totals.gider} tone="neg" />
        <StatCard title="Net" value={totals.net} tone={totals.net >= 0 ? 'pos' : 'neg'} />
        <StatCard
          title="Açık Alacak"
          value={openLending}
          tone={openLending > 0 ? 'neg' : 'neutral'}
          hint="Verdiğin, henüz geri almadığın para"
        />
      </div>

      {/* ------------------------------------------------- verdiğim borçlar */}
      {lendings.length > 0 && (
        <Card
          title="Verdiğim Borçlar"
          actions={<span className="text-xs text-muted">Açık toplam {formatTRY(openLending)}</span>}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className="th">Kişi</th>
                  <th className="th">Verildiği tarih</th>
                  <th className="th">Çıkan hesap</th>
                  <th className="th text-right">Tutar</th>
                  <th className="th">Durum</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {lendings.map((r) => {
                  const value = Number(r.amount) * Number(r.fx_rate ?? 1)
                  return (
                    <tr key={r.id} className={r.is_collected ? 'opacity-60' : ''}>
                      <td className="td font-medium">
                        {r.person}
                        {r.note && <div className="text-xs text-muted">{r.note}</div>}
                      </td>
                      <td className="td text-muted whitespace-nowrap">
                        {format(parseISO(r.given_date), 'd MMM yyyy', { locale: tr })}
                        {r.expected_date && !r.is_collected && (
                          <div className="text-xs">
                            beklenen {format(parseISO(r.expected_date), 'd MMM', { locale: tr })}
                          </div>
                        )}
                      </td>
                      <td className="td text-muted">{accountName(r.account_id)}</td>
                      <td className="td text-right num">{formatTRY(value)}</td>
                      <td className="td">
                        {r.is_collected ? (
                          <Badge tone="pos">
                            {accountName(r.collected_account_id)} · {r.collected_date}
                          </Badge>
                        ) : (
                          <Badge tone="warn">Bekliyor</Badge>
                        )}
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        <div className="inline-flex gap-1">
                          {r.is_collected ? (
                            <button
                              className="btn-ghost text-xs"
                              onClick={() => void guard(() => uncollect(r), false)}
                            >
                              Geri al
                            </button>
                          ) : (
                            <button
                              className="btn-primary text-xs"
                              onClick={() => {
                                setFormError(null)
                                setModal({ type: 'collect', row: r })
                              }}
                            >
                              Aldım
                            </button>
                          )}
                          <button
                            className="btn-danger text-xs"
                            onClick={() => {
                              if (confirm(`${r.person} kaydı ve para hareketleri silinsin mi?`)) {
                                void guard(() => removeLending(r.id).then(reloadLendings), false)
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
          <p className="mt-3 text-xs text-muted">
            Borç verdiğinde tutar seçtiğin hesabın bakiyesinden düşer, "Aldım" dediğinde
            seçtiğin hesaba geri yatar. Hareketler Nakit sayfasındaki deftere de yazılır.
          </p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select
          className="ml-auto"
          value={dirFilter}
          onChange={(e) => setDirFilter(e.target.value as TxDirection | '')}
        >
          <option value="">Gelir + Gider</option>
          <option value="gelir">Sadece gelir</option>
          <option value="gider">Sadece gider</option>
        </select>
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value as TxCategory | '')}>
          <option value="">Tüm kategoriler</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <Card title="Aylık Gider — kategori bazlı">
        {chartData.length === 0 ? (
          <Empty>Gider kaydı yok.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={cc.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: cc.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: cc.grid }}
                tickFormatter={(v) => format(parseISO(String(v) + '-01'), 'MMM yy', { locale: tr })}
              />
              <YAxis
                tick={{ fill: cc.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={70}
                tickFormatter={(v) => formatCompactTRY(Number(v))}
              />
              <Tooltip
                cursor={{ fill: cc.cursor }}
                contentStyle={{
                  background: cc.tooltipBg,
                  border: `1px solid ${cc.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: any, n: any) => [formatTRY(Number(v)), n]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: cc.legend }} />
              {chartCats.map((c, i) => (
                <Bar key={c} dataKey={c} stackId="gider" fill={colorAt(i)} radius={[0, 0, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card className="p-0 overflow-x-auto">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <Empty>Kayıt yok.</Empty>
        ) : (
          <table className="w-full min-w-[780px]">
            <thead>
              <tr>
                <th className="th">Tarih</th>
                <th className="th">Başlık</th>
                <th className="th">Kategori</th>
                <th className="th">Hesap</th>
                <th className="th text-right">Tutar</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const value = Number(r.amount) * Number(r.fx_rate ?? 1)
                return (
                  <tr key={r.id} className="hover:bg-surface2/50">
                    <td className="td text-muted whitespace-nowrap">
                      {format(parseISO(r.date), 'd MMM yyyy', { locale: tr })}
                    </td>
                    <td className="td font-medium">
                      {r.title}
                      {r.note && <div className="text-xs text-muted">{r.note}</div>}
                    </td>
                    <td className="td">
                      <Badge tone={r.direction === 'gelir' ? 'pos' : 'muted'}>
                        {catLabel(r.category)}
                      </Badge>
                    </td>
                    <td className="td text-muted">{accountName(r.account_id)}</td>
                    <td className={`td text-right num ${r.direction === 'gelir' ? 'text-pos' : 'text-neg'}`}>
                      {r.direction === 'gelir' ? '+' : '−'}
                      {formatTRY(value)}
                    </td>
                    <td className="td text-right whitespace-nowrap">
                      <div className="inline-flex gap-1">
                        <button className="btn-ghost text-xs" onClick={() => openEntry(r)}>
                          Düzenle
                        </button>
                        <button
                          className="btn-danger text-xs"
                          onClick={() => confirm('Silinsin mi?') && remove(r.id)}
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
        )}
      </Card>

      {/* ------------------------------------------------------------ modal */}
      <Modal
        open={modal?.type === 'entry'}
        title={editing ? 'Kaydı Düzenle' : 'Yeni Kayıt'}
        onClose={() => {
          setModal(null)
          setFormError(null)
        }}
      >
        <form onSubmit={submitEntry} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Tür</label>
              <select
                className="w-full"
                value={kind}
                onChange={(e) => setKind(e.target.value as EntryKind)}
                disabled={!!editing}
              >
                <option value="gider">Gider</option>
                <option value="gelir">Gelir</option>
                <option value="borc">Borç verdim</option>
              </select>
            </div>
            <div>
              <label className="label">{kind === 'borc' ? 'Verildiği tarih' : 'Tarih'}</label>
              <input type="date" name="date" className="w-full" defaultValue={editing?.date ?? todayISO()} />
            </div>

            <div className="sm:col-span-2">
              <label className="label">{kind === 'borc' ? 'Kime verdin?' : 'Başlık'}</label>
              <input
                name="title"
                className="w-full"
                placeholder={kind === 'borc' ? 'Örn. Ahmet' : 'Elektrik faturası - Ağustos'}
                defaultValue={editing?.title ?? ''}
                required
              />
            </div>

            {kind === 'borc' ? (
              <div>
                <label className="label">Beklenen geri dönüş</label>
                <input type="date" name="expected_date" className="w-full" />
              </div>
            ) : (
              <div>
                <label className="label">Kategori</label>
                <select name="category" className="w-full" defaultValue={editing?.category ?? 'fatura'}>
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="label">{kind === 'borc' ? 'Hangi hesaptan?' : 'Hesap'}</label>
              <select
                name="account_id"
                className="w-full"
                defaultValue={editing?.account_id ?? ''}
                required={kind === 'borc'}
              >
                <option value="">—</option>
                {ownAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label">Tutar</label>
              <input
                name="amount"
                inputMode="decimal"
                className="w-full num"
                defaultValue={editing?.amount ?? ''}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Birim</label>
                <select name="currency" className="w-full" defaultValue={editing?.currency ?? 'TRY'}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Kur</label>
                <input
                  name="fx_rate"
                  inputMode="decimal"
                  className="w-full num"
                  defaultValue={editing?.fx_rate ?? 1}
                />
              </div>
            </div>
          </div>
          <div>
            <label className="label">Not</label>
            <input name="note" className="w-full" defaultValue={editing?.note ?? ''} />
          </div>

          {kind === 'borc' && (
            <p className="text-xs text-muted">
              Tutar seçtiğin hesabın bakiyesinden düşer. Parayı geri aldığında listeden "Aldım"
              dersin, hangi hesaba yattığını orada seçersin.
            </p>
          )}

          {formError && <ErrorBox message={formError} />}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
              Vazgeç
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={modal?.type === 'collect'}
        title="Borcu Geri Aldım"
        onClose={() => setModal(null)}
      >
        {modal?.type === 'collect' && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              void guard(() =>
                collect(
                  modal.row,
                  String(fd.get('account_id') ?? ''),
                  String(fd.get('date') ?? todayISO()),
                  parseAmount(String(fd.get('amount') ?? ''))
                )
              )
            }}
            className="space-y-3"
          >
            {formError && <ErrorBox message={formError} />}
            <p className="text-sm text-muted">
              <span className="text-ink font-medium">{modal.row.person}</span> kişisine{' '}
              {format(parseISO(modal.row.given_date), 'd MMMM yyyy', { locale: tr })} tarihinde{' '}
              {formatTRY(Number(modal.row.amount) * Number(modal.row.fx_rate ?? 1))} vermiştin
              ({accountName(modal.row.account_id)} hesabından).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Hangi hesaba yattı?</label>
                <select name="account_id" className="w-full" defaultValue={modal.row.account_id ?? ''} required>
                  <option value="" disabled>
                    Hesap seç…
                  </option>
                  {ownAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Tutar</label>
                <input
                  name="amount"
                  inputMode="decimal"
                  className="w-full num"
                  defaultValue={Number(modal.row.amount) * Number(modal.row.fx_rate ?? 1)}
                  required
                />
              </div>
              <div>
                <label className="label">Tarih</label>
                <input type="date" name="date" className="w-full" defaultValue={todayISO()} />
              </div>
            </div>
            <p className="text-xs text-muted">
              Faizle ya da eksik geri aldıysan tutarı değiştirebilirsin — hesaba yazılan tutar
              buradaki rakamdır.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button className="btn-primary" disabled={busy}>
                {busy ? 'İşleniyor…' : 'Hesaba yatır'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
