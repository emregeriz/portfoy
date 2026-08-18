import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useTable } from '../hooks/useTable'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatTRY, parseAmount } from '../lib/currency'
import { todayISO } from '../lib/calc'
import type { Currency, Liability, LiabilityType, Receivable } from '../types/db'

type Tab = 'alacak' | 'borc'

const DEBT_TYPES: { value: LiabilityType; label: string }[] = [
  { value: 'kredi_karti', label: 'Kredi Kartı' },
  { value: 'kredi', label: 'Kredi' },
  { value: 'kisisel_borc', label: 'Kişisel Borç' },
  { value: 'diger', label: 'Diğer' },
]

export default function Debts() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  const [tab, setTab] = useState<Tab>('alacak')
  const effectiveScope = scope || user?.id || ''
  const isOwn = effectiveScope === user?.id

  const receivables = useTable<Receivable>('receivables', {
    userId: effectiveScope,
    orderBy: 'given_date',
    ascending: false,
  })
  const liabilities = useTable<Liability>('liabilities', {
    userId: effectiveScope,
    orderBy: 'created_at',
    ascending: false,
  })

  const [modal, setModal] = useState<Receivable | Liability | 'new' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const openReceivables = receivables.rows.filter((r) => !r.is_collected)
  const openLiabilities = liabilities.rows.filter((l) => !l.is_settled)

  const totalReceivable = useMemo(
    () => openReceivables.reduce((s, r) => s + Number(r.amount) * Number(r.fx_rate ?? 1), 0),
    [openReceivables]
  )
  const totalLiability = useMemo(
    () => openLiabilities.reduce((s, l) => s + Number(l.amount) * Number(l.fx_rate ?? 1), 0),
    [openLiabilities]
  )

  const byPerson = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of openReceivables) {
      map.set(r.person, (map.get(r.person) ?? 0) + Number(r.amount) * Number(r.fx_rate ?? 1))
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [openReceivables])

  const editing = modal && modal !== 'new' ? modal : null

  const submitReceivable = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const values = {
      user_id: user.id,
      person: String(fd.get('person') ?? '').trim(),
      amount: parseAmount(String(fd.get('amount') ?? '')),
      currency: String(fd.get('currency') ?? 'TRY') as Currency,
      fx_rate: parseAmount(String(fd.get('fx_rate') ?? '1')) || 1,
      given_date: String(fd.get('given_date') ?? todayISO()),
      expected_date: String(fd.get('expected_date') ?? '') || null,
      note: String(fd.get('note') ?? '').trim() || null,
    }
    if (!values.person) return setFormError('Kişi adı gerekli.')
    try {
      if (modal === 'new') await receivables.insert(values)
      else await receivables.update((modal as Receivable).id, values)
      setModal(null)
      setFormError(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  const submitLiability = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const values = {
      user_id: user.id,
      title: String(fd.get('title') ?? '').trim(),
      type: String(fd.get('type') ?? 'kisisel_borc') as LiabilityType,
      counterparty: String(fd.get('counterparty') ?? '').trim() || null,
      amount: parseAmount(String(fd.get('amount') ?? '')),
      currency: String(fd.get('currency') ?? 'TRY') as Currency,
      fx_rate: parseAmount(String(fd.get('fx_rate') ?? '1')) || 1,
      due_date: String(fd.get('due_date') ?? '') || null,
      note: String(fd.get('note') ?? '').trim() || null,
    }
    if (!values.title) return setFormError('Başlık gerekli.')
    try {
      if (modal === 'new') await liabilities.insert(values)
      else await liabilities.update((modal as Liability).id, values)
      setModal(null)
      setFormError(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Borç & Alacak"
        subtitle="Verdiğin borçlar ve senin borçların."
        actions={
          <button className="btn-primary" onClick={() => setModal('new')} disabled={!isOwn}>
            + {tab === 'alacak' ? 'Alacak' : 'Borç'} ekle
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <UserTabs
          profiles={profiles}
          currentUserId={user?.id}
          value={effectiveScope}
          onChange={setScope}
          showTotal={false}
        />
        <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1 ml-auto">
          <button
            onClick={() => setTab('alacak')}
            className={`px-3 py-1.5 rounded-md text-sm ${
              tab === 'alacak' ? 'bg-surface2 text-slate-100' : 'text-muted'
            }`}
          >
            Verdiğim Borçlar
          </button>
          <button
            onClick={() => setTab('borc')}
            className={`px-3 py-1.5 rounded-md text-sm ${
              tab === 'borc' ? 'bg-surface2 text-slate-100' : 'text-muted'
            }`}
          >
            Borçlarım
          </button>
        </div>
      </div>

      {(receivables.error || liabilities.error) && (
        <ErrorBox message={receivables.error ?? liabilities.error ?? ''} />
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Toplam Alacak" value={totalReceivable} tone="pos" />
        <StatCard title="Toplam Borç" value={totalLiability} tone="neg" />
        <StatCard
          title="Net"
          value={totalReceivable - totalLiability}
          tone={totalReceivable - totalLiability >= 0 ? 'pos' : 'neg'}
        />
      </div>

      {tab === 'alacak' ? (
        <>
          {byPerson.length > 0 && (
            <Card title="Kişi bazlı toplam">
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {byPerson.map(([person, amount]) => (
                  <li
                    key={person}
                    className="flex items-center justify-between rounded-lg border border-border bg-surface2/40 px-3 py-2 text-sm"
                  >
                    <span>{person}</span>
                    <span className="num font-medium text-pos">{formatTRY(amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-0 overflow-x-auto">
            {receivables.loading ? (
              <Spinner />
            ) : receivables.rows.length === 0 ? (
              <Empty>Verilen borç kaydı yok.</Empty>
            ) : (
              <table className="w-full min-w-[760px]">
                <thead>
                  <tr>
                    <th className="th">Kişi</th>
                    <th className="th text-right">Tutar</th>
                    <th className="th">Verildiği tarih</th>
                    <th className="th">Beklenen</th>
                    <th className="th">Durum</th>
                    <th className="th"></th>
                  </tr>
                </thead>
                <tbody>
                  {receivables.rows.map((r) => (
                    <tr key={r.id} className="hover:bg-surface2/50">
                      <td className="td font-medium">
                        {r.person}
                        {r.note && <div className="text-xs text-muted">{r.note}</div>}
                      </td>
                      <td className="td text-right num">
                        {formatTRY(Number(r.amount) * Number(r.fx_rate ?? 1))}
                      </td>
                      <td className="td text-muted">
                        {format(parseISO(r.given_date), 'd MMM yyyy', { locale: tr })}
                      </td>
                      <td className="td text-muted">
                        {r.expected_date
                          ? format(parseISO(r.expected_date), 'd MMM yyyy', { locale: tr })
                          : '—'}
                      </td>
                      <td className="td">
                        <Badge tone={r.is_collected ? 'pos' : 'warn'}>
                          {r.is_collected ? 'Tahsil edildi' : 'Bekliyor'}
                        </Badge>
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        {isOwn ? (
                          <div className="inline-flex gap-1">
                            <button
                              className="btn-ghost text-xs"
                              onClick={() =>
                                receivables.update(r.id, {
                                  is_collected: !r.is_collected,
                                  collected_date: r.is_collected ? null : todayISO(),
                                })
                              }
                            >
                              {r.is_collected ? 'Geri al' : 'Tahsil et'}
                            </button>
                            <button className="btn-ghost text-xs" onClick={() => setModal(r)}>
                              Düzenle
                            </button>
                            <button
                              className="btn-danger text-xs"
                              onClick={() => confirm('Silinsin mi?') && receivables.remove(r.id)}
                            >
                              Sil
                            </button>
                          </div>
                        ) : (
                          <Badge>salt okunur</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      ) : (
        <Card className="p-0 overflow-x-auto">
          {liabilities.loading ? (
            <Spinner />
          ) : liabilities.rows.length === 0 ? (
            <Empty>Borç kaydı yok.</Empty>
          ) : (
            <table className="w-full min-w-[760px]">
              <thead>
                <tr>
                  <th className="th">Başlık</th>
                  <th className="th">Tür</th>
                  <th className="th">Kime</th>
                  <th className="th text-right">Tutar</th>
                  <th className="th">Vade</th>
                  <th className="th">Durum</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {liabilities.rows.map((l) => (
                  <tr key={l.id} className="hover:bg-surface2/50">
                    <td className="td font-medium">{l.title}</td>
                    <td className="td text-muted">
                      {DEBT_TYPES.find((t) => t.value === l.type)?.label ?? l.type}
                    </td>
                    <td className="td text-muted">{l.counterparty ?? '—'}</td>
                    <td className="td text-right num text-neg">
                      {formatTRY(Number(l.amount) * Number(l.fx_rate ?? 1))}
                    </td>
                    <td className="td text-muted">
                      {l.due_date ? format(parseISO(l.due_date), 'd MMM yyyy', { locale: tr }) : '—'}
                    </td>
                    <td className="td">
                      <Badge tone={l.is_settled ? 'pos' : 'neg'}>
                        {l.is_settled ? 'Kapandı' : 'Açık'}
                      </Badge>
                      {l.snapshot_id && (
                        <span className="ml-1 text-xs text-muted">snapshot</span>
                      )}
                    </td>
                    <td className="td text-right whitespace-nowrap">
                      {isOwn ? (
                        <div className="inline-flex gap-1">
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => liabilities.update(l.id, { is_settled: !l.is_settled })}
                          >
                            {l.is_settled ? 'Aç' : 'Kapat'}
                          </button>
                          <button className="btn-ghost text-xs" onClick={() => setModal(l)}>
                            Düzenle
                          </button>
                          <button
                            className="btn-danger text-xs"
                            onClick={() => confirm('Silinsin mi?') && liabilities.remove(l.id)}
                          >
                            Sil
                          </button>
                        </div>
                      ) : (
                        <Badge>salt okunur</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Modal
        open={modal !== null}
        title={
          tab === 'alacak'
            ? modal === 'new'
              ? 'Yeni Alacak'
              : 'Alacağı Düzenle'
            : modal === 'new'
              ? 'Yeni Borç'
              : 'Borcu Düzenle'
        }
        onClose={() => {
          setModal(null)
          setFormError(null)
        }}
      >
        {tab === 'alacak' ? (
          <form onSubmit={submitReceivable} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Kişi</label>
                <input
                  name="person"
                  className="w-full"
                  defaultValue={(editing as Receivable | null)?.person ?? ''}
                  required
                />
              </div>
              <div>
                <label className="label">Tutar</label>
                <input
                  name="amount"
                  inputMode="decimal"
                  className="w-full num"
                  defaultValue={(editing as Receivable | null)?.amount ?? ''}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Birim</label>
                  <select
                    name="currency"
                    className="w-full"
                    defaultValue={(editing as Receivable | null)?.currency ?? 'TRY'}
                  >
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
                    defaultValue={(editing as Receivable | null)?.fx_rate ?? 1}
                  />
                </div>
              </div>
              <div>
                <label className="label">Verildiği tarih</label>
                <input
                  type="date"
                  name="given_date"
                  className="w-full"
                  defaultValue={(editing as Receivable | null)?.given_date ?? todayISO()}
                />
              </div>
              <div>
                <label className="label">Beklenen tarih</label>
                <input
                  type="date"
                  name="expected_date"
                  className="w-full"
                  defaultValue={(editing as Receivable | null)?.expected_date ?? ''}
                />
              </div>
            </div>
            <div>
              <label className="label">Not</label>
              <input name="note" className="w-full" defaultValue={(editing as Receivable | null)?.note ?? ''} />
            </div>
            {formError && <ErrorBox message={formError} />}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button type="submit" className="btn-primary">
                Kaydet
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submitLiability} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Başlık</label>
                <input
                  name="title"
                  className="w-full"
                  defaultValue={(editing as Liability | null)?.title ?? ''}
                  required
                />
              </div>
              <div>
                <label className="label">Tür</label>
                <select
                  name="type"
                  className="w-full"
                  defaultValue={(editing as Liability | null)?.type ?? 'kisisel_borc'}
                >
                  {DEBT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Kime</label>
                <input
                  name="counterparty"
                  className="w-full"
                  defaultValue={(editing as Liability | null)?.counterparty ?? ''}
                />
              </div>
              <div>
                <label className="label">Tutar</label>
                <input
                  name="amount"
                  inputMode="decimal"
                  className="w-full num"
                  defaultValue={(editing as Liability | null)?.amount ?? ''}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Birim</label>
                  <select
                    name="currency"
                    className="w-full"
                    defaultValue={(editing as Liability | null)?.currency ?? 'TRY'}
                  >
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
                    defaultValue={(editing as Liability | null)?.fx_rate ?? 1}
                  />
                </div>
              </div>
              <div>
                <label className="label">Vade</label>
                <input
                  type="date"
                  name="due_date"
                  className="w-full"
                  defaultValue={(editing as Liability | null)?.due_date ?? ''}
                />
              </div>
            </div>
            <div>
              <label className="label">Not</label>
              <input name="note" className="w-full" defaultValue={(editing as Liability | null)?.note ?? ''} />
            </div>
            {formError && <ErrorBox message={formError} />}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button type="submit" className="btn-primary">
                Kaydet
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
