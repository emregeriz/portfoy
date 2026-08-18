import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useTable } from '../hooks/useTable'
import StatCard from '../components/StatCard'
import NetWorthChart, { type ChartPoint } from '../components/NetWorthChart'
import { Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { change, todayISO } from '../lib/calc'
import { formatPercent, formatTRY, parseAmount } from '../lib/currency'
import type { TakipEntry, TakipExpense } from '../types/db'

const DEFAULT_ITEMS = ['Annem', 'Babam', 'Mablam', 'Nablam', 'Garanti', 'Ziraat', 'Midas', 'Tera']

const sumItems = (items: Record<string, number> | null | undefined) =>
  Object.values(items ?? {}).reduce((s, v) => s + Number(v || 0), 0)

const fmtDate = (iso: string) => format(parseISO(iso), 'd MMM yyyy', { locale: tr })

interface FormRow {
  name: string
  value: string
  custom?: boolean
}

type EntryValues = {
  entry_date: string
  items: Record<string, number>
  debt: number
  expenses: TakipExpense[]
  note: string | null
}

const expensesSum = (list: TakipExpense[] | null | undefined) =>
  (list ?? []).reduce((s, x) => s + Number(x.amount || 0), 0)

function EntryForm({
  entry,
  itemNames,
  onSave,
  onClose,
}: {
  entry: TakipEntry | null
  itemNames: string[]
  onSave: (values: EntryValues) => Promise<void>
  onClose: () => void
}) {
  const [date, setDate] = useState(entry?.entry_date ?? todayISO())
  const [rows, setRows] = useState<FormRow[]>(() =>
    itemNames.map((n) => ({
      name: n,
      value: entry?.items?.[n] != null ? String(entry.items[n]) : '',
    }))
  )
  const [debt, setDebt] = useState(entry && Number(entry.debt) !== 0 ? String(entry.debt) : '')
  const [note, setNote] = useState(entry?.note ?? '')
  const [expRows, setExpRows] = useState<{ desc: string; amount: string }[]>(() =>
    (entry?.expenses ?? []).map((x) => ({ desc: x.desc, amount: String(x.amount) }))
  )
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const total = rows.reduce((s, r) => s + parseAmount(r.value), 0)
  const net = total - parseAmount(debt)

  const setRow = (i: number, patch: Partial<FormRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const items: Record<string, number> = {}
    for (const r of rows) {
      const name = r.name.trim()
      if (!name || r.value.trim() === '') continue
      items[name] = parseAmount(r.value)
    }
    const expenses: TakipExpense[] = expRows
      .filter((r) => r.desc.trim() || r.amount.trim())
      .map((r) => ({ desc: r.desc.trim(), amount: parseAmount(r.amount) }))
    try {
      await onSave({
        entry_date: date,
        items,
        debt: parseAmount(debt),
        expenses,
        note: note.trim() || null,
      })
      onClose()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="takip-date">Tarih</label>
        <input
          id="takip-date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      <div>
        <div className="label">Varlıklar</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              {r.custom ? (
                <input
                  placeholder="Kalem adı"
                  className="w-32 shrink-0"
                  value={r.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                />
              ) : (
                <span className="w-32 shrink-0 text-sm text-muted">{r.name}</span>
              )}
              <input
                inputMode="decimal"
                placeholder="0"
                className="w-full text-right num"
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost text-xs mt-2"
          onClick={() => setRows((prev) => [...prev, { name: '', value: '', custom: true }])}
        >
          + Kalem Ekle
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="takip-debt">Borç</label>
          <input
            id="takip-debt"
            inputMode="decimal"
            placeholder="0"
            className="w-full text-right num"
            value={debt}
            onChange={(e) => setDebt(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="takip-note">Not</label>
          <input
            id="takip-note"
            placeholder="—"
            className="w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      <div>
        <div className="label">Ek Giderler</div>
        {expRows.length > 0 && (
          <div className="space-y-2">
            {expRows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  placeholder="Açıklama"
                  className="w-full"
                  value={r.desc}
                  onChange={(e) =>
                    setExpRows((prev) => prev.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)))
                  }
                />
                <input
                  inputMode="decimal"
                  placeholder="0"
                  className="w-32 shrink-0 text-right num"
                  value={r.amount}
                  onChange={(e) =>
                    setExpRows((prev) => prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className="btn-ghost text-xs shrink-0"
                  aria-label="Gideri kaldır"
                  onClick={() => setExpRows((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn-ghost text-xs mt-2"
          onClick={() => setExpRows((prev) => [...prev, { desc: '', amount: '' }])}
        >
          + Ek Gider
        </button>
      </div>

      <div className="flex items-center justify-between text-sm border-t border-border pt-3">
        <span className="text-muted">
          Toplam: <span className="num text-ink">{formatTRY(total)}</span>
        </span>
        <span className="text-muted">
          Net: <span className={`num font-medium ${net >= 0 ? 'text-pos' : 'text-neg'}`}>{formatTRY(net)}</span>
        </span>
      </div>

      {err && <ErrorBox message={err} />}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Vazgeç
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Kaydediliyor…' : entry ? 'Güncelle' : 'Kaydet'}
        </button>
      </div>
    </form>
  )
}

export default function Takip() {
  const { user } = useAuth()
  const { rows, loading, error, insert, update, remove } = useTable<TakipEntry>('takip_entries', {
    userId: user?.id,
    orderBy: 'entry_date',
    ascending: true,
  })

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TakipEntry | null>(null)

  // Varsayılan kalemler + geçmiş kayıtlarda kullanılan tüm kalem adları
  const itemNames = useMemo(() => {
    const names = [...DEFAULT_ITEMS]
    for (const e of rows) {
      for (const k of Object.keys(e.items ?? {})) if (!names.includes(k)) names.push(k)
    }
    return names
  }, [rows])

  const computed = useMemo(
    () =>
      rows.map((e) => {
        const gross = sumItems(e.items)
        return { ...e, gross, net: gross - Number(e.debt || 0) }
      }),
    [rows]
  )

  const hasDebt = computed.some((e) => Number(e.debt) > 0)

  const last = computed[computed.length - 1] ?? null

  // Karşılaştırma aralığı — varsayılan: ilk kayıt → son kayıt
  const dates = useMemo(() => [...new Set(computed.map((e) => e.entry_date))], [computed])
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const selStart = (rangeStart && dates.includes(rangeStart) ? rangeStart : dates[0]) ?? ''
  const selEnd = (rangeEnd && dates.includes(rangeEnd) ? rangeEnd : dates[dates.length - 1]) ?? ''
  const [lo, hi] = selStart <= selEnd ? [selStart, selEnd] : [selEnd, selStart]
  const startEntry = computed.find((e) => e.entry_date === lo) ?? null
  const endEntry = [...computed].reverse().find((e) => e.entry_date === hi) ?? null

  // Ek giderler: "harcanmasaydı" senaryosu — aralık içinde harcananlar net'e geri eklenir
  const [includeExpenses, setIncludeExpenses] = useState(false)
  const rangeExpenses = useMemo(
    () =>
      computed
        .filter((e) => e.entry_date > lo && e.entry_date <= hi)
        .reduce((s, e) => s + expensesSum(e.expenses), 0),
    [computed, lo, hi]
  )
  const displayNet = (endEntry?.net ?? 0) + (includeExpenses ? rangeExpenses : 0)
  const rangeChange =
    startEntry && endEntry && lo !== hi ? change(displayNet, startEntry.net) : null

  const allExpenses = useMemo(
    () =>
      [...computed]
        .reverse()
        .flatMap((e) => (e.expenses ?? []).map((x) => ({ ...x, date: e.entry_date }))),
    [computed]
  )
  const totalExpenses = allExpenses.reduce((s, x) => s + Number(x.amount || 0), 0)

  const chartData: ChartPoint[] = useMemo(
    () =>
      computed
        .filter((e) => e.entry_date >= lo && e.entry_date <= hi)
        .map((e) => ({ date: e.entry_date, net: e.net, brut: e.gross })),
    [computed, lo, hi]
  )

  const series = [
    { key: 'net', label: 'Net Portföy', color: '#4f8cff' },
    ...(hasDebt ? [{ key: 'brut', label: 'Borç Düşülmeden', color: '#22c55e' }] : []),
  ]

  const debtRows = useMemo(
    () => [...computed].reverse().filter((e) => Number(e.debt) > 0 || e.note),
    [computed]
  )

  const openNew = () => {
    setEditing(null)
    setModalOpen(true)
  }
  const openEdit = (e: TakipEntry) => {
    setEditing(e)
    setModalOpen(true)
  }

  const save = async (values: EntryValues) => {
    if (editing) await update(editing.id, values)
    else await insert({ ...values, user_id: user?.id })
  }

  const missingTable = error != null && /takip_entries/.test(error)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Takip"
        subtitle={
          last ? `Son kayıt: ${fmtDate(last.entry_date)}` : 'Henüz kayıt yok'
        }
        actions={
          <button className="btn-primary" onClick={openNew}>
            + Ekle
          </button>
        }
      />

      {error && (
        <div className="space-y-2">
          <ErrorBox message={error} />
          {missingTable && (
            <p className="text-sm text-muted">
              Tablo henüz oluşturulmamış görünüyor. Supabase panelinde SQL Editor'ü açıp{' '}
              <code className="text-accent">supabase/takip.sql</code> dosyasının içeriğini çalıştır,
              sonra bu sayfayı yenile.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Toplam Varlık" value={last?.gross ?? 0} />
        <StatCard
          title="Borç"
          value={last?.debt ?? 0}
          tone={(last?.debt ?? 0) > 0 ? 'neg' : 'neutral'}
        />
        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted uppercase tracking-wide">Net Portföy</div>
            {totalExpenses > 0 && (
              <button
                type="button"
                onClick={() => setIncludeExpenses((v) => !v)}
                title="Ek giderler harcanmamış olsaydı"
                className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-colors ${
                  includeExpenses
                    ? 'bg-accent/15 text-accent border-accent/40'
                    : 'text-muted border-border hover:text-ink'
                }`}
              >
                +Gider
              </button>
            )}
          </div>
          <div
            className={`mt-2 text-2xl font-semibold num ${displayNet >= 0 ? 'text-pos' : 'text-neg'}`}
          >
            {formatTRY(displayNet)}
          </div>
          {includeExpenses && rangeExpenses > 0 && (
            <div className="text-xs text-muted">{formatTRY(rangeExpenses)} ek gider dahil</div>
          )}
          {rangeChange ? (
            <div
              className={`mt-1 text-sm num ${rangeChange.absolute >= 0 ? 'text-pos' : 'text-neg'}`}
            >
              {formatPercent(rangeChange.percent)} ({rangeChange.absolute >= 0 ? '+' : ''}
              {formatTRY(rangeChange.absolute)})
            </div>
          ) : (
            <div className="mt-1 text-sm text-muted">Karşılaştırma için 2. kayıt gerekli</div>
          )}
          {dates.length > 1 && (
            <div className="mt-2 flex items-center gap-1.5">
              <select
                className="flex-1 min-w-0 px-2 py-1 text-xs"
                value={selStart}
                onChange={(e) => setRangeStart(e.target.value)}
                aria-label="Başlangıç tarihi"
              >
                {dates.map((d) => (
                  <option key={d} value={d}>{fmtDate(d)}</option>
                ))}
              </select>
              <span className="text-muted text-xs shrink-0">→</span>
              <select
                className="flex-1 min-w-0 px-2 py-1 text-xs"
                value={selEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                aria-label="Bitiş tarihi"
              >
                {dates.map((d) => (
                  <option key={d} value={d}>{fmtDate(d)}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <StatCard
          title="Ek Gider"
          value={totalExpenses}
          tone={totalExpenses > 0 ? 'neg' : 'neutral'}
          hint={
            allExpenses.length > 0 ? (
              <div className="space-y-0.5">
                {allExpenses.slice(0, 3).map((x, i) => (
                  <div key={i} className="flex justify-between gap-2">
                    <span className="truncate">{x.desc || fmtDate(x.date)}</span>
                    <span className="num shrink-0">{formatTRY(x.amount)}</span>
                  </div>
                ))}
                {allExpenses.length > 3 && <div>+{allExpenses.length - 3} kalem daha</div>}
              </div>
            ) : (
              'Ekle modalından ek gider girebilirsin'
            )
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Portföy Gelişimi" className="lg:col-span-2">
          {loading ? <Spinner /> : <NetWorthChart data={chartData} series={series} />}
        </Card>

        <Card title="Borç & Notlar">
          {debtRows.length === 0 ? (
            <Empty>Borç veya not girilmedi.</Empty>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Tarih</th>
                    <th className="th text-right">Borç</th>
                    <th className="th">Not</th>
                  </tr>
                </thead>
                <tbody>
                  {debtRows.map((e) => (
                    <tr key={e.id}>
                      <td className="td whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                      <td className="td text-right num whitespace-nowrap">
                        {Number(e.debt) > 0 ? (
                          <span className="text-neg">{formatTRY(e.debt)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td text-muted">{e.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Kayıtlar">
        {loading ? (
          <Spinner />
        ) : computed.length === 0 ? (
          <Empty>Sağ üstteki "+ Ekle" ile ilk kaydını gir.</Empty>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Tarih</th>
                  {itemNames.map((n) => (
                    <th key={n} className="th text-right">{n}</th>
                  ))}
                  <th className="th text-right">Toplam</th>
                  <th className="th text-right">Borç</th>
                  <th className="th text-right">Net</th>
                  <th className="th text-right">Değişim</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {computed.map((e, i) => {
                  const prevNet = i > 0 ? computed[i - 1].net : null
                  const diff = prevNet !== null ? change(e.net, prevNet) : null
                  return (
                    <tr key={e.id}>
                      <td className="td whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                      {itemNames.map((n) => (
                        <td key={n} className="td text-right num whitespace-nowrap">
                          {e.items?.[n] != null ? formatTRY(e.items[n]) : '—'}
                        </td>
                      ))}
                      <td className="td text-right num whitespace-nowrap font-medium">
                        {formatTRY(e.gross)}
                      </td>
                      <td className="td text-right num whitespace-nowrap">
                        {Number(e.debt) > 0 ? (
                          <span className="text-neg">{formatTRY(e.debt)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td text-right num whitespace-nowrap font-medium">
                        {formatTRY(e.net)}
                      </td>
                      <td className="td text-right num whitespace-nowrap">
                        {diff ? (
                          <span className={diff.absolute >= 0 ? 'text-pos' : 'text-neg'}>
                            {diff.absolute >= 0 ? '+' : ''}
                            {formatTRY(diff.absolute)}
                            {diff.percent !== null && ` (${formatPercent(diff.percent)})`}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        <button className="btn-ghost text-xs" onClick={() => openEdit(e)}>
                          Düzenle
                        </button>{' '}
                        <button
                          className="btn-danger text-xs"
                          onClick={() => confirm('Silinsin mi?') && remove(e.id)}
                        >
                          Sil
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={modalOpen}
        title={editing ? 'Kaydı Düzenle' : 'Yeni Kayıt'}
        onClose={() => setModalOpen(false)}
      >
        <EntryForm
          key={editing?.id ?? 'new'}
          entry={editing}
          itemNames={itemNames}
          onSave={save}
          onClose={() => setModalOpen(false)}
        />
      </Modal>
    </div>
  )
}
