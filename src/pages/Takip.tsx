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
import type { TakipEntry } from '../types/db'

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
  note: string | null
}

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
    try {
      await onSave({
        entry_date: date,
        items,
        debt: parseAmount(debt),
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

  const chartData: ChartPoint[] = useMemo(
    () => computed.map((e) => ({ date: e.entry_date, net: e.net, brut: e.gross })),
    [computed]
  )

  const series = [
    { key: 'net', label: 'Net Portföy', color: '#4f8cff' },
    ...(hasDebt ? [{ key: 'brut', label: 'Borç Düşülmeden', color: '#22c55e' }] : []),
  ]

  const last = computed[computed.length - 1] ?? null
  const prev = computed[computed.length - 2] ?? null
  const netChange = change(last?.net ?? 0, prev?.net)

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
        <StatCard
          title="Net Portföy"
          value={last?.net ?? 0}
          change={netChange}
          tone={(last?.net ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <StatCard
          title="Kayıt Sayısı"
          value={String(computed.length)}
          hint={prev ? `Önceki: ${formatTRY(prev.net)}` : 'Karşılaştırma için 2. kayıt gerekli'}
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
