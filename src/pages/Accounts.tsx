import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useAccounts } from '../hooks/useAccounts'
import { supabase } from '../lib/supabase'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatTRY } from '../lib/currency'
import type { Account, AccountType, Currency, PositionWithRefs } from '../types/db'
import { POSITION_SELECT } from '../hooks/useSnapshots'

const TYPES: { value: AccountType; label: string }[] = [
  { value: 'banka', label: 'Banka' },
  { value: 'aracikurum', label: 'Aracı Kurum' },
  { value: 'nakit', label: 'Nakit' },
  { value: 'kripto', label: 'Kripto Borsası' },
  { value: 'diger', label: 'Diğer' },
]

export default function Accounts() {
  const { user } = useAuth()
  const { accounts, loading, error, reload } = useAccounts(user?.id)
  const [modal, setModal] = useState<Account | 'new' | null>(null)
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // Son snapshot'taki hesap bakiyeleri
  useEffect(() => {
    if (!user) return
    const run = async () => {
      const { data: snap } = await supabase
        .from('snapshots')
        .select('id')
        .eq('user_id', user.id)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!snap) return setBalances({})
      const { data } = await supabase.from('positions').select(POSITION_SELECT).eq('snapshot_id', snap.id)
      const map: Record<string, number> = {}
      for (const p of (data ?? []) as unknown as PositionWithRefs[]) {
        if (p.account_id) map[p.account_id] = (map[p.account_id] ?? 0) + Number(p.amount_try ?? 0)
      }
      setBalances(map)
    }
    void run()
  }, [user?.id, accounts.length])

  const total = useMemo(() => Object.values(balances).reduce((s, v) => s + v, 0), [balances])

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const values = {
      user_id: user.id,
      name: String(fd.get('name') ?? '').trim(),
      type: String(fd.get('type') ?? 'banka') as AccountType,
      currency: String(fd.get('currency') ?? 'TRY') as Currency,
      is_active: fd.get('is_active') === 'on',
      note: String(fd.get('note') ?? '') || null,
    }
    if (!values.name) return setFormError('Hesap adı gerekli.')

    const res =
      modal === 'new'
        ? await supabase.from('accounts').insert(values)
        : await supabase.from('accounts').update(values).eq('id', (modal as Account).id)

    if (res.error) setFormError(res.error.message)
    else {
      setFormError(null)
      setModal(null)
      await reload()
    }
  }

  const del = async (a: Account) => {
    if (!confirm(`"${a.name}" hesabı silinsin mi? Geçmiş kalemlerde hesap bilgisi boşalır.`)) return
    const { error } = await supabase.from('accounts').delete().eq('id', a.id)
    if (!error) await reload()
  }

  const editing = modal && modal !== 'new' ? modal : null

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hesaplar"
        subtitle="Banka, aracı kurum, nakit ve cüzdanların."
        actions={
          <button className="btn-primary" onClick={() => setModal('new')}>
            + Hesap ekle
          </button>
        }
      />

      {error && <ErrorBox message={error} />}

      <Card className="p-0 overflow-x-auto">
        {loading ? (
          <Spinner />
        ) : accounts.length === 0 ? (
          <Empty>Henüz hesap yok. İlk hesabını ekle.</Empty>
        ) : (
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th">Hesap</th>
                <th className="th">Tür</th>
                <th className="th">Para Birimi</th>
                <th className="th text-right">Güncel Bakiye</th>
                <th className="th text-right">Pay</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const bal = balances[a.id] ?? 0
                return (
                  <tr key={a.id} className="hover:bg-surface2/50">
                    <td className="td">
                      <div className="font-medium">{a.name}</div>
                      {a.note && <div className="text-xs text-muted">{a.note}</div>}
                    </td>
                    <td className="td">
                      <Badge tone={a.is_active ? 'accent' : 'muted'}>
                        {TYPES.find((t) => t.value === a.type)?.label ?? a.type}
                      </Badge>
                    </td>
                    <td className="td text-muted">{a.currency}</td>
                    <td className="td text-right num">{formatTRY(bal)}</td>
                    <td className="td text-right num text-muted">
                      {total ? ((bal / total) * 100).toFixed(1).replace('.', ',') : '0,0'}%
                    </td>
                    <td className="td text-right whitespace-nowrap">
                      <div className="inline-flex gap-1">
                        <button className="btn-ghost text-xs" onClick={() => setModal(a)}>
                          Düzenle
                        </button>
                        <button className="btn-danger text-xs" onClick={() => del(a)}>
                          Sil
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="td font-medium" colSpan={3}>
                  Toplam
                </td>
                <td className="td text-right num font-semibold">{formatTRY(total)}</td>
                <td className="td" colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      <Modal
        open={modal !== null}
        title={modal === 'new' ? 'Yeni Hesap' : 'Hesabı Düzenle'}
        onClose={() => {
          setModal(null)
          setFormError(null)
        }}
      >
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Hesap adı</label>
            <input name="name" className="w-full" defaultValue={editing?.name ?? ''} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Tür</label>
              <select name="type" className="w-full" defaultValue={editing?.type ?? 'banka'}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Para birimi</label>
              <select name="currency" className="w-full" defaultValue={editing?.currency ?? 'TRY'}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Not</label>
            <input name="note" className="w-full" defaultValue={editing?.note ?? ''} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="is_active"
              defaultChecked={editing?.is_active ?? true}
              className="w-4 h-4"
            />
            Aktif
          </label>

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
