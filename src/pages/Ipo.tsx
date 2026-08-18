import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useTable } from '../hooks/useTable'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatPercent, formatTRY, parseAmount } from '../lib/currency'
import { todayISO } from '../lib/calc'
import type { Ipo, IpoStatus } from '../types/db'

const STATUSES: { value: IpoStatus; label: string; tone: string }[] = [
  { value: 'talep_verildi', label: 'Talep Verildi', tone: 'warn' },
  { value: 'dagitildi', label: 'Dağıtıldı', tone: 'accent' },
  { value: 'satildi', label: 'Satıldı', tone: 'pos' },
  { value: 'iptal', label: 'İptal', tone: 'muted' },
]

const statusMeta = (s: IpoStatus) => STATUSES.find((x) => x.value === s) ?? STATUSES[0]

export default function IpoPage() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  const effectiveScope = scope || user?.id || ''

  const { rows, loading, error, insert, update, remove } = useTable<Ipo>('ipo_participations', {
    userId: effectiveScope,
    orderBy: 'ipo_date',
    ascending: false,
  })

  const [modal, setModal] = useState<Ipo | 'new' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [ownerFilter, setOwnerFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | IpoStatus>('')

  const owners = useMemo(
    () => [...new Set(rows.map((r) => r.account_owner).filter(Boolean) as string[])].sort(),
    [rows]
  )

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (!ownerFilter || r.account_owner === ownerFilter) &&
          (!statusFilter || r.status === statusFilter)
      ),
    [rows, ownerFilter, statusFilter]
  )

  const summary = useMemo(() => {
    const participated = filtered.filter((r) => r.status !== 'iptal')
    const totalCost = participated.reduce((s, r) => s + Number(r.total_cost ?? 0), 0)
    const sold = filtered.filter((r) => r.status === 'satildi')
    const totalProfit = sold.reduce((s, r) => s + Number(r.profit ?? 0), 0)
    const soldCost = sold.reduce((s, r) => s + Number(r.total_cost ?? 0), 0)
    return {
      count: participated.length,
      totalCost,
      totalProfit,
      avgReturn: soldCost ? (totalProfit / soldCost) * 100 : null,
    }
  }, [filtered])

  const editing = modal && modal !== 'new' ? modal : null
  const isOwn = effectiveScope === user?.id

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const num = (k: string) => {
      const v = String(fd.get(k) ?? '').trim()
      return v ? parseAmount(v) : null
    }
    const values = {
      user_id: user.id,
      ipo_name: String(fd.get('ipo_name') ?? '').trim(),
      ipo_date: String(fd.get('ipo_date') ?? '') || null,
      account_owner: String(fd.get('account_owner') ?? '').trim() || null,
      broker: String(fd.get('broker') ?? '').trim() || null,
      requested_amount: num('requested_amount'),
      allocated_lot: num('allocated_lot'),
      cost_price: num('cost_price'),
      status: String(fd.get('status') ?? 'talep_verildi') as IpoStatus,
      sold_date: String(fd.get('sold_date') ?? '') || null,
      sold_price: num('sold_price'),
      shared_with: String(fd.get('shared_with') ?? '').trim() || null,
      note: String(fd.get('note') ?? '').trim() || null,
    }
    if (!values.ipo_name) return setFormError('Arz adı gerekli.')
    try {
      if (modal === 'new') await insert(values)
      else await update((modal as Ipo).id, values)
      setModal(null)
      setFormError(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Halka Arz"
        subtitle="Hangi hesaptan, hangi kurumdan katıldın ve ne kazandın."
        actions={
          <button className="btn-primary" onClick={() => setModal('new')}>
            + Arz ekle
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
        <select className="ml-auto" value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
          <option value="">Tüm hesap sahipleri</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as IpoStatus | '')}>
          <option value="">Tüm durumlar</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Katılım" value={String(summary.count)} hint="iptal edilmeyen arz sayısı" />
        <StatCard title="Toplam Maliyet" value={summary.totalCost} />
        <StatCard
          title="Toplam Kâr"
          value={summary.totalProfit}
          tone={summary.totalProfit >= 0 ? 'pos' : 'neg'}
          hint="satılan arzlar"
        />
        <StatCard
          title="Ortalama Getiri"
          value={summary.avgReturn === null ? '—' : formatPercent(summary.avgReturn)}
          tone={(summary.avgReturn ?? 0) >= 0 ? 'pos' : 'neg'}
        />
      </div>

      <Card className="p-0 overflow-x-auto">
        {loading ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <Empty>Kayıt yok.</Empty>
        ) : (
          <table className="w-full min-w-[900px]">
            <thead>
              <tr>
                <th className="th">Arz</th>
                <th className="th">Tarih</th>
                <th className="th">Hesap Sahibi</th>
                <th className="th">Aracı Kurum</th>
                <th className="th text-right">Lot</th>
                <th className="th text-right">Maliyet</th>
                <th className="th">Durum</th>
                <th className="th text-right">Kâr</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const meta = statusMeta(r.status)
                const profit = Number(r.profit ?? 0)
                return (
                  <tr key={r.id} className="hover:bg-surface2/50">
                    <td className="td font-medium">{r.ipo_name}</td>
                    <td className="td text-muted">
                      {r.ipo_date ? format(parseISO(r.ipo_date), 'd MMM yyyy', { locale: tr }) : '—'}
                    </td>
                    <td className="td">{r.account_owner ?? '—'}</td>
                    <td className="td text-muted">{r.broker ?? '—'}</td>
                    <td className="td text-right num">{formatNumber(r.allocated_lot, 0)}</td>
                    <td className="td text-right num">{formatTRY(r.total_cost)}</td>
                    <td className="td">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </td>
                    <td
                      className={`td text-right num ${
                        r.status === 'satildi' ? (profit >= 0 ? 'text-pos' : 'text-neg') : 'text-muted'
                      }`}
                    >
                      {r.status === 'satildi' ? formatTRY(profit) : '—'}
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

      <datalist id="ipo-owners">
        {owners.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>

      <Modal
        open={modal !== null}
        title={modal === 'new' ? 'Yeni Halka Arz' : 'Arzı Düzenle'}
        onClose={() => {
          setModal(null)
          setFormError(null)
        }}
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Arz adı</label>
              <input name="ipo_name" className="w-full" defaultValue={editing?.ipo_name ?? ''} required />
            </div>
            <div>
              <label className="label">Talep tarihi</label>
              <input
                type="date"
                name="ipo_date"
                className="w-full"
                defaultValue={editing?.ipo_date ?? todayISO()}
              />
            </div>
            <div>
              <label className="label">Hesap sahibi</label>
              <input
                name="account_owner"
                list="ipo-owners"
                className="w-full"
                placeholder="Kendim / Ahmet / Babam"
                defaultValue={editing?.account_owner ?? ''}
              />
            </div>
            <div>
              <label className="label">Aracı kurum</label>
              <input
                name="broker"
                className="w-full"
                placeholder="Midas, İş Yatırım…"
                defaultValue={editing?.broker ?? ''}
              />
            </div>
            <div>
              <label className="label">Talep tutarı</label>
              <input
                name="requested_amount"
                inputMode="decimal"
                className="w-full num"
                defaultValue={editing?.requested_amount ?? ''}
              />
            </div>
            <div>
              <label className="label">Dağıtılan lot</label>
              <input
                name="allocated_lot"
                inputMode="decimal"
                className="w-full num"
                defaultValue={editing?.allocated_lot ?? ''}
              />
            </div>
            <div>
              <label className="label">Arz fiyatı</label>
              <input
                name="cost_price"
                inputMode="decimal"
                className="w-full num"
                defaultValue={editing?.cost_price ?? ''}
              />
            </div>
            <div>
              <label className="label">Durum</label>
              <select name="status" className="w-full" defaultValue={editing?.status ?? 'talep_verildi'}>
                {STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Satış tarihi</label>
              <input type="date" name="sold_date" className="w-full" defaultValue={editing?.sold_date ?? ''} />
            </div>
            <div>
              <label className="label">Satış fiyatı</label>
              <input
                name="sold_price"
                inputMode="decimal"
                className="w-full num"
                defaultValue={editing?.sold_price ?? ''}
              />
            </div>
          </div>
          <div>
            <label className="label">Kâr paylaşımı</label>
            <input
              name="shared_with"
              className="w-full"
              placeholder="Örn. yarı yarıya Ahmet ile"
              defaultValue={editing?.shared_with ?? ''}
            />
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
