import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useNetWorth, usePositions } from '../hooks/useSnapshots'
import { supabase } from '../lib/supabase'
import UserTabs from '../components/UserTabs'
import { Badge, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatTRY } from '../lib/currency'
import { change } from '../lib/calc'
import { KIND_LABELS } from '../lib/calc'

export default function History() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveScope = scope || user?.id || ''
  const { rows, loading, reload } = useNetWorth(effectiveScope)

  const ordered = useMemo(
    () => [...rows].sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date)),
    [rows]
  )

  const { positions, loading: posLoading } = usePositions(openId)

  const del = async (snapshotId: string) => {
    if (!confirm('Bu kayıt ve içindeki tüm kalemler silinecek. Emin misin?')) return
    const { error } = await supabase.from('snapshots').delete().eq('id', snapshotId)
    if (error) setError(error.message)
    else {
      setOpenId(null)
      await reload()
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Geçmiş"
        subtitle="Tüm snapshot kayıtları, tarih sırasıyla."
        actions={
          <Link to="/snapshot/new" className="btn-primary">
            + Yeni Giriş
          </Link>
        }
      />

      <UserTabs
        profiles={profiles}
        currentUserId={user?.id}
        value={effectiveScope}
        onChange={setScope}
        showTotal={false}
      />

      {error && <ErrorBox message={error} />}

      <Card className="overflow-x-auto p-0">
        {loading ? (
          <Spinner />
        ) : ordered.length === 0 ? (
          <Empty>Henüz kayıt yok.</Empty>
        ) : (
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Tarih</th>
                <th className="th text-right">Varlık</th>
                <th className="th text-right">Borç</th>
                <th className="th text-right">Net Değer</th>
                <th className="th text-right">Değişim</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r, i) => {
                const prev = ordered[i + 1]
                const c = change(r.net_worth_try, prev?.net_worth_try)
                const isOwn = r.user_id === user?.id
                const isOpen = openId === r.snapshot_id
                return (
                  <Fragment key={r.snapshot_id}>
                    <tr className="hover:bg-surface2/50">
                      <td className="td">
                        <button
                          className="font-medium hover:text-accent"
                          onClick={() => setOpenId(isOpen ? null : r.snapshot_id)}
                        >
                          {format(parseISO(r.snapshot_date), 'd MMMM yyyy', { locale: tr })}
                        </button>
                      </td>
                      <td className="td text-right num">{formatTRY(r.total_assets_try)}</td>
                      <td className="td text-right num text-neg">
                        {r.total_liabilities_try ? formatTRY(r.total_liabilities_try) : '—'}
                      </td>
                      <td className="td text-right num font-semibold">{formatTRY(r.net_worth_try)}</td>
                      <td
                        className={`td text-right num ${
                          c.percent === null ? 'text-muted' : c.absolute >= 0 ? 'text-pos' : 'text-neg'
                        }`}
                      >
                        {c.percent === null
                          ? '—'
                          : `${c.absolute >= 0 ? '+' : ''}${formatNumber(c.percent)}%`}
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        {isOwn ? (
                          <div className="inline-flex gap-1">
                            <Link to={`/snapshot/${r.snapshot_id}/edit`} className="btn-ghost text-xs">
                              Düzenle
                            </Link>
                            <button className="btn-danger text-xs" onClick={() => del(r.snapshot_id)}>
                              Sil
                            </button>
                          </div>
                        ) : (
                          <Badge>salt okunur</Badge>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} className="border-t border-border bg-surface2/30 p-3">
                          {posLoading ? (
                            <Spinner label="Kalemler yükleniyor…" />
                          ) : positions.length === 0 ? (
                            <Empty>Bu kayıtta kalem yok.</Empty>
                          ) : (
                            <table className="w-full">
                              <thead>
                                <tr>
                                  <th className="th">Hesap</th>
                                  <th className="th">Varlık</th>
                                  <th className="th">Tür</th>
                                  <th className="th text-right">Adet</th>
                                  <th className="th text-right">Tutar</th>
                                  <th className="th text-right">TRY</th>
                                  <th className="th">Not</th>
                                </tr>
                              </thead>
                              <tbody>
                                {positions.map((p) => (
                                  <tr key={p.id}>
                                    <td className="td">{p.accounts?.name ?? '—'}</td>
                                    <td className="td font-medium">{p.assets?.symbol ?? '—'}</td>
                                    <td className="td text-muted">
                                      {p.assets ? KIND_LABELS[p.assets.kind] : '—'}
                                    </td>
                                    <td className="td text-right num">
                                      {p.quantity != null ? formatNumber(p.quantity, 4) : '—'}
                                    </td>
                                    <td className="td text-right num">
                                      {formatNumber(p.amount)} {p.currency}
                                    </td>
                                    <td className="td text-right num">{formatTRY(p.amount_try)}</td>
                                    <td className="td text-muted">{p.note ?? ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
