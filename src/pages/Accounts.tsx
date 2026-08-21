import { Fragment, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useAccounts } from '../hooks/useAccounts'
import { usePrices } from '../hooks/usePrices'
import { useTrades } from '../hooks/useTrades'
import { useIpos } from '../hooks/useIpos'
import { ipoVirtualTrades } from '../lib/ipoTrades'
import { supabase } from '../lib/supabase'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatNumber, formatPercent, formatTRY, parseAmount } from '../lib/currency'
import { formatRate } from '../lib/nema'
import { computeHoldings, type Holding } from '../lib/holdings'
import type {
  Account,
  AccountBalance,
  AccountType,
  Currency,
  PositionWithRefs,
  TradeWithRefs,
} from '../types/db'
import { POSITION_SELECT } from '../hooks/useSnapshots'

const TYPES: { value: AccountType; label: string }[] = [
  { value: 'banka', label: 'Banka' },
  { value: 'aracikurum', label: 'Aracı Kurum' },
  { value: 'nakit', label: 'Nakit' },
  { value: 'kripto', label: 'Kripto Borsası' },
  { value: 'diger', label: 'Diğer' },
]

/** Hesaptaki açık pozisyonların güncel değeri; fiyatı yoksa maliyetiyle sayılır */
const stockValueOf = (holdings: Holding[]) =>
  holdings.filter((h) => h.quantity > 0).reduce((s, h) => s + (h.value ?? h.costBasis), 0)

/** Bir hesabın alım/satım defterinden türeyen hisse pozisyonları */
function HoldingsPanel({ holdings }: { holdings: Holding[] }) {
  const open = holdings.filter((h) => h.quantity > 0)
  const closed = holdings.filter((h) => h.quantity <= 0)
  const totalValue = stockValueOf(holdings)
  const totalCost = open.reduce((s, h) => s + h.costBasis, 0)
  const totalUnrealized = open.reduce((s, h) => s + (h.unrealized ?? 0), 0)
  const realizedNet = holdings.reduce((s, h) => s + h.realizedNet, 0)

  return (
    <div className="space-y-2">
      {open.length === 0 ? (
        <p className="text-xs text-muted">Açık pozisyon yok.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Sembol</th>
              <th className="th text-right">Adet</th>
              <th className="th text-right">Ort. maliyet</th>
              <th className="th text-right">Maliyet</th>
              <th className="th text-right">Güncel fiyat</th>
              <th className="th text-right">Değer</th>
              <th className="th text-right">Kâr / Zarar</th>
            </tr>
          </thead>
          <tbody>
            {open.map((h) => (
              <tr key={h.symbol}>
                <td className="td font-medium">
                  {h.symbol}
                  <span className="ml-2 text-xs text-muted">{h.kind}</span>
                </td>
                <td className="td text-right num">{formatNumber(h.quantity, 4)}</td>
                <td className="td text-right num text-muted">{formatNumber(h.avgCost, 6)}</td>
                <td className="td text-right num">{formatTRY(h.costBasis)}</td>
                <td className="td text-right num text-muted">
                  {h.price != null ? formatNumber(h.price, 6) : '—'}
                </td>
                <td className="td text-right num">{h.value != null ? formatTRY(h.value) : '—'}</td>
                <td className="td text-right num">
                  {h.unrealized != null ? (
                    <span className={h.unrealized >= 0 ? 'text-pos' : 'text-neg'}>
                      {formatTRY(h.unrealized)}
                      {h.unrealizedPct != null && (
                        <span className="ml-1 text-xs">{formatPercent(h.unrealizedPct)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted">fiyat yok</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-muted">
        Hisse değeri <span className="num text-ink">{formatTRY(totalValue)}</span> · maliyet{' '}
        <span className="num">{formatTRY(totalCost)}</span> · açık K/Z{' '}
        <span className={`num ${totalUnrealized >= 0 ? 'text-pos' : 'text-neg'}`}>
          {formatTRY(totalUnrealized)}
        </span>
        {realizedNet !== 0 && (
          <>
            {' '}
            · gerçekleşen net{' '}
            <span className={`num ${realizedNet >= 0 ? 'text-pos' : 'text-neg'}`}>
              {formatTRY(realizedNet)}
            </span>
          </>
        )}
        {closed.length > 0 && <> · {closed.length} kapanmış pozisyon</>}
      </p>
    </div>
  )
}

interface TableProps {
  accounts: Account[]
  /** Hesaptaki nakit — account_ledger toplamı */
  cash: Record<string, number>
  holdingsMap: Map<string, Holding[]>
  openRows: Set<string>
  onToggle: (id: string) => void
  onEdit: (a: Account) => void
  onDelete: (a: Account) => void
  emptyText: string
}

function AccountTable({
  accounts,
  cash,
  holdingsMap,
  openRows,
  onToggle,
  onEdit,
  onDelete,
  emptyText,
}: TableProps) {
  const rowTotal = (id: string) => (cash[id] ?? 0) + stockValueOf(holdingsMap.get(id) ?? [])
  const grand = accounts.reduce((s, a) => s + rowTotal(a.id), 0)
  const totalCash = accounts.reduce((s, a) => s + (cash[a.id] ?? 0), 0)
  const totalStocks = grand - totalCash

  if (accounts.length === 0) return <Empty>{emptyText}</Empty>

  return (
    <table className="w-full min-w-[760px]">
      <thead>
        <tr>
          <th className="th">Hesap</th>
          <th className="th">Tür</th>
          <th className="th">Para Birimi</th>
          <th className="th text-right">Nakit</th>
          <th className="th text-right">Hisse Değeri</th>
          <th className="th text-right">Pay</th>
          <th className="th"></th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((a) => {
          const holdings = holdingsMap.get(a.id) ?? []
          const openCount = holdings.filter((h) => h.quantity > 0).length
          const sv = stockValueOf(holdings)
          const expanded = openRows.has(a.id)
          const total = rowTotal(a.id)
          return (
            <Fragment key={a.id}>
              <tr className="hover:bg-surface2/50">
                <td className="td">
                  <div className="font-medium">{a.name}</div>
                  {a.note && <div className="text-xs text-muted">{a.note}</div>}
                </td>
                <td className="td">
                  <Badge tone={a.is_active ? 'accent' : 'muted'}>
                    {TYPES.find((t) => t.value === a.type)?.label ?? a.type}
                  </Badge>
                </td>
                <td className="td text-muted">
                  {a.currency}
                  {Number(a.nema_rate) > 0 && (
                    <span className="ml-2 text-xs text-accent">
                      %{formatRate(a.nema_rate)} nema
                    </span>
                  )}
                </td>
                <td className="td text-right num">{formatTRY(cash[a.id] ?? 0)}</td>
                <td className="td text-right whitespace-nowrap">
                  {holdings.length > 0 ? (
                    <button className="btn-ghost text-xs num" onClick={() => onToggle(a.id)}>
                      {formatTRY(sv)} · {openCount} hisse {expanded ? '▴' : '▾'}
                    </button>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="td text-right num text-muted">
                  {grand ? ((total / grand) * 100).toFixed(1).replace('.', ',') : '0,0'}%
                </td>
                <td className="td text-right whitespace-nowrap">
                  <div className="inline-flex gap-1">
                    <button className="btn-ghost text-xs" onClick={() => onEdit(a)}>
                      Düzenle
                    </button>
                    <button className="btn-danger text-xs" onClick={() => onDelete(a)}>
                      Sil
                    </button>
                  </div>
                </td>
              </tr>
              {expanded && (
                <tr>
                  <td colSpan={7} className="bg-surface2/30 px-4 py-3">
                    <HoldingsPanel holdings={holdings} />
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
      <tfoot>
        <tr>
          <td className="td font-medium" colSpan={3}>
            Toplam
          </td>
          <td className="td text-right num font-semibold">{formatTRY(totalCash)}</td>
          <td className="td text-right num font-semibold">{formatTRY(totalStocks)}</td>
          <td className="td text-right num text-muted" colSpan={2}>
            = {formatTRY(grand)}
          </td>
        </tr>
      </tfoot>
    </table>
  )
}

export default function Accounts() {
  const { user } = useAuth()
  const { accounts, loading, error, reload } = useAccounts(user?.id)
  const { rows: tradeRows } = useTrades(user?.id)
  const ipoData = useIpos(user?.id)
  const { bySymbol } = usePrices()
  const [modal, setModal] = useState<Account | 'new' | null>(null)
  const [cash, setCash] = useState<Record<string, number>>({})
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)

  /**
   * Hesaptaki nakit önce defterden (account_ledger) okunur — Nakit ve Halka
   * Arz sayfalarıyla aynı kaynak. Defterde hareketi olmayan hesaplar için
   * son snapshot'taki tutar yedek olarak kullanılır.
   */
  useEffect(() => {
    if (!user) return
    const run = async () => {
      const map: Record<string, number> = {}

      const { data: snap } = await supabase
        .from('snapshots')
        .select('id')
        .eq('user_id', user.id)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (snap) {
        const { data } = await supabase
          .from('positions')
          .select(POSITION_SELECT)
          .eq('snapshot_id', snap.id)
        for (const p of (data ?? []) as unknown as PositionWithRefs[]) {
          if (p.account_id) map[p.account_id] = (map[p.account_id] ?? 0) + Number(p.amount_try ?? 0)
        }
      }

      const { data: bal } = await supabase
        .from('v_account_balances')
        .select('*')
        .eq('user_id', user.id)
      for (const b of (bal ?? []) as AccountBalance[]) {
        map[b.account_id] = Number(b.balance)
      }

      setCash(map)
    }
    void run()
  }, [user?.id, accounts.length])

  /** Hesap bazında hisse pozisyonları — alım/satım defteri + arzdan türeyen sanal işlemler */
  const holdingsMap = useMemo(() => {
    const virtual = ipoVirtualTrades(ipoData.ipos, ipoData.entries, ipoData.accounts)
    const grouped = new Map<string, TradeWithRefs[]>()
    for (const t of [...tradeRows, ...virtual]) {
      if (!t.account_id) continue
      const list = grouped.get(t.account_id)
      if (list) list.push(t)
      else grouped.set(t.account_id, [t])
    }
    const map = new Map<string, Holding[]>()
    for (const [id, list] of grouped) map.set(id, computeHoldings(list, bySymbol))
    return map
  }, [tradeRows, bySymbol, ipoData.ipos, ipoData.entries, ipoData.accounts])

  const regular = useMemo(() => accounts.filter((a) => !a.is_ipo), [accounts])
  const ipoAccounts = useMemo(() => accounts.filter((a) => a.is_ipo), [accounts])

  const toggleRow = (id: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
      // İşaretliyse hesap Halka Arz sayfasına taşınır, Nakit sayfasında görünmez
      is_ipo: fd.get('is_ipo') === 'on',
      note: String(fd.get('note') ?? '') || null,
      // Yıllık nemalandırma oranı — Nakit sayfası günlük faizi bundan işler
      nema_rate: parseAmount(String(fd.get('nema_rate') ?? '')),
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
        ) : (
          <AccountTable
            accounts={regular}
            cash={cash}
            holdingsMap={holdingsMap}
            openRows={openRows}
            onToggle={toggleRow}
            onEdit={setModal}
            onDelete={del}
            emptyText="Henüz hesap yok. İlk hesabını ekle."
          />
        )}
      </Card>

      {!loading && ipoAccounts.length > 0 && (
        <div className="space-y-2">
          <div>
            <h2 className="text-lg font-semibold">Halka Arz Hesapları</h2>
            <p className="text-sm text-muted">
              Aile ve tanıdık hesapları — nakit Halka Arz sayfasındaki defterden, hisseler
              alım/satım kayıtlarından gelir.
            </p>
          </div>
          <Card className="p-0 overflow-x-auto">
            <AccountTable
              accounts={ipoAccounts}
              cash={cash}
              holdingsMap={holdingsMap}
              openRows={openRows}
              onToggle={toggleRow}
              onEdit={setModal}
              onDelete={del}
              emptyText="Halka arz hesabı yok."
            />
          </Card>
        </div>
      )}

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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Nemalandırma (yıllık %)</label>
              <input
                name="nema_rate"
                className="w-full num"
                inputMode="decimal"
                placeholder="0"
                defaultValue={editing?.nema_rate ? formatRate(editing.nema_rate) : ''}
              />
            </div>
            <div>
              <label className="label">Not</label>
              <input name="note" className="w-full" defaultValue={editing?.note ?? ''} />
            </div>
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="is_ipo"
              defaultChecked={editing?.is_ipo ?? false}
              className="w-4 h-4"
            />
            Halka arz hesabı — Halka Arz sayfasında listelenir, Nakit sayfasında görünmez
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
