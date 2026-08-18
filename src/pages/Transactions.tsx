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
import { useTable } from '../hooks/useTable'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatCompactTRY, formatTRY, parseAmount } from '../lib/currency'
import { colorAt, todayISO } from '../lib/calc'
import type { Currency, Transaction, TxCategory, TxDirection } from '../types/db'

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

export default function Transactions() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  const effectiveScope = scope || user?.id || ''

  const { accounts } = useAccounts(effectiveScope)
  const { rows, loading, error, insert, update, remove } = useTable<Transaction>('transactions', {
    userId: effectiveScope,
    orderBy: 'date',
    ascending: false,
  })

  const [modal, setModal] = useState<Transaction | 'new' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [catFilter, setCatFilter] = useState<'' | TxCategory>('')
  const [dirFilter, setDirFilter] = useState<'' | TxDirection>('')

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

  const editing = modal && modal !== 'new' ? modal : null
  const isOwn = effectiveScope === user?.id

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const values = {
      user_id: user.id,
      account_id: String(fd.get('account_id') ?? '') || null,
      date: String(fd.get('date') ?? todayISO()),
      direction: String(fd.get('direction') ?? 'gider') as TxDirection,
      category: String(fd.get('category') ?? 'diger') as TxCategory,
      title: String(fd.get('title') ?? '').trim(),
      amount: parseAmount(String(fd.get('amount') ?? '')),
      currency: String(fd.get('currency') ?? 'TRY') as Currency,
      fx_rate: parseAmount(String(fd.get('fx_rate') ?? '1')) || 1,
      note: String(fd.get('note') ?? '').trim() || null,
    }
    if (!values.title) return setFormError('Başlık gerekli.')
    try {
      if (modal === 'new') await insert(values)
      else await update((modal as Transaction).id, values)
      setModal(null)
      setFormError(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Gelir / Gider"
        subtitle="Fatura, seyahat, market, maaş — nakit akışın."
        actions={
          <button className="btn-primary" onClick={() => setModal('new')}>
            + Kayıt ekle
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
        <select className="ml-auto" value={dirFilter} onChange={(e) => setDirFilter(e.target.value as TxDirection | '')}>
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

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Toplam Gelir" value={totals.gelir} tone="pos" />
        <StatCard title="Toplam Gider" value={totals.gider} tone="neg" />
        <StatCard title="Net" value={totals.net} tone={totals.net >= 0 ? 'pos' : 'neg'} />
      </div>

      <Card title="Aylık Gider — kategori bazlı">
        {chartData.length === 0 ? (
          <Empty>Gider kaydı yok.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="#243047" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: '#8b9ab3', fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: '#243047' }}
                tickFormatter={(v) => format(parseISO(String(v) + '-01'), 'MMM yy', { locale: tr })}
              />
              <YAxis
                tick={{ fill: '#8b9ab3', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={70}
                tickFormatter={(v) => formatCompactTRY(Number(v))}
              />
              <Tooltip
                cursor={{ fill: '#ffffff08' }}
                contentStyle={{
                  background: '#1a2233',
                  border: '1px solid #243047',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(v: any, n: any) => [formatTRY(Number(v)), n]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: '#8b9ab3' }} />
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
                const account = accounts.find((a) => a.id === r.account_id)
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
                    <td className="td text-muted">{account?.name ?? '—'}</td>
                    <td className={`td text-right num ${r.direction === 'gelir' ? 'text-pos' : 'text-neg'}`}>
                      {r.direction === 'gelir' ? '+' : '−'}
                      {formatTRY(value)}
                    </td>
                    <td className="td text-right whitespace-nowrap">
                      {isOwn ? (
                        <div className="inline-flex gap-1">
                          <button className="btn-ghost text-xs" onClick={() => setModal(r)}>
                            Düzenle
                          </button>
                          <button
                            className="btn-danger text-xs"
                            onClick={() => confirm('Silinsin mi?') && remove(r.id)}
                          >
                            Sil
                          </button>
                        </div>
                      ) : (
                        <Badge>salt okunur</Badge>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        open={modal !== null}
        title={modal === 'new' ? 'Yeni Kayıt' : 'Kaydı Düzenle'}
        onClose={() => {
          setModal(null)
          setFormError(null)
        }}
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Tarih</label>
              <input type="date" name="date" className="w-full" defaultValue={editing?.date ?? todayISO()} />
            </div>
            <div>
              <label className="label">Yön</label>
              <select name="direction" className="w-full" defaultValue={editing?.direction ?? 'gider'}>
                <option value="gider">Gider</option>
                <option value="gelir">Gelir</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Başlık</label>
              <input
                name="title"
                className="w-full"
                placeholder="Elektrik faturası - Ağustos"
                defaultValue={editing?.title ?? ''}
                required
              />
            </div>
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
            <div>
              <label className="label">Hesap</label>
              <select name="account_id" className="w-full" defaultValue={editing?.account_id ?? ''}>
                <option value="">—</option>
                {accounts.map((a) => (
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
      </Modal>
    </div>
  )
}
