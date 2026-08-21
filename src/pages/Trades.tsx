import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useAccounts } from '../hooks/useAccounts'
import { useAssets } from '../hooks/useAssets'
import { usePrices } from '../hooks/usePrices'
import { useTrades } from '../hooks/useTrades'
import { useIpos } from '../hooks/useIpos'
import { ipoVirtualTrades, isIpoTrade } from '../lib/ipoTrades'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatNumber, formatPercent, formatTRY, parseAmount } from '../lib/currency'
import { todayISO } from '../lib/calc'
import { computeHoldings, holdingTotals, DEFAULT_TAX_RATE } from '../lib/holdings'
import type { AssetKind, Currency, TradeSide, TradeWithRefs } from '../types/db'

const KINDS: AssetKind[] = ['hisse', 'fon', 'doviz', 'altin', 'mevduat', 'kripto', 'diger']

/** Hesap filtresinde "hesap seçilmemiş" kayıtları için özel değer */
const NO_ACCOUNT = '__none__'

/** Adet × birim fiyat — küsurat farkı olmadığı sürece tutar buradan gelir */
const product = (qty: string, unit: string) => {
  const q = parseAmount(qty)
  const u = parseAmount(unit)
  return q > 0 && u > 0 ? q * u : 0
}

export default function Trades() {
  const { user } = useAuth()
  const effectiveScope = user?.id ?? ''
  const isOwn = true

  const { accounts } = useAccounts()
  const { assets, ensureAsset } = useAssets()
  const { bySymbol, latestDate } = usePrices()

  const trades = useTrades(effectiveScope)
  const ipoData = useIpos(effectiveScope)

  const [modal, setModal] = useState<TradeWithRefs | 'new' | null>(null)
  /** Pozisyonları hesap bazında ayır — aynı kâğıt iki kurumda ayrı satır olur */
  const [byAccount, setByAccount] = useState(false)
  /** Boş = tüm hesaplar; NO_ACCOUNT = hesabı seçilmemiş kayıtlar */
  const [accountFilter, setAccountFilter] = useState('')
  /** Kapanan pozisyonlar varsayılan gizli — tablo açık pozisyonlara odaklanır */
  const [showClosed, setShowClosed] = useState(false)
  // İşlem geçmişi filtreleri
  const [histQuery, setHistQuery] = useState('')
  const [histSide, setHistSide] = useState<'' | TradeSide>('')
  const [histFrom, setHistFrom] = useState('')
  const [histTo, setHistTo] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Form alanları — adet / birim fiyat / tutar birbirine bağlı
  const [side, setSide] = useState<TradeSide>('alis')
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState('')
  const [amount, setAmount] = useState('')
  const [orderAmount, setOrderAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('TRY')

  const regularAccounts = useMemo(() => accounts.filter((a) => !a.is_ipo), [accounts])
  const ipoAccounts = useMemo(() => accounts.filter((a) => a.is_ipo), [accounts])
  const hasOrphanTrades = useMemo(() => trades.rows.some((t) => !t.account_id), [trades.rows])

  /**
   * Halka arz dağıtım/satışları sanal işlem olarak deftere katılır —
   * kaynak Halka Arz modülü, burada salt okunur görünürler.
   */
  const virtualTrades = useMemo(
    () => ipoVirtualTrades(ipoData.ipos, ipoData.entries, ipoData.accounts),
    [ipoData.ipos, ipoData.entries, ipoData.accounts]
  )
  const allRows = useMemo(
    () =>
      [...trades.rows, ...virtualTrades].sort(
        (a, b) =>
          b.trade_date.localeCompare(a.trade_date) || b.created_at.localeCompare(a.created_at)
      ),
    [trades.rows, virtualTrades]
  )

  /** Hesap filtresi pozisyonlara, özetlere ve işlem geçmişine birlikte uygulanır */
  const filteredTrades = useMemo(() => {
    if (!accountFilter) return allRows
    if (accountFilter === NO_ACCOUNT) return allRows.filter((t) => !t.account_id)
    return allRows.filter((t) => t.account_id === accountFilter)
  }, [allRows, accountFilter])

  const holdings = useMemo(
    () => computeHoldings(filteredTrades, bySymbol, { byAccount }),
    [filteredTrades, bySymbol, byAccount]
  )
  const totals = useMemo(() => holdingTotals(holdings), [holdings])
  const openHoldings = useMemo(() => holdings.filter((h) => h.quantity > 0), [holdings])
  const closedHoldings = useMemo(() => holdings.filter((h) => h.quantity <= 0), [holdings])

  /** İşlem geçmişi — hesap filtresinin üstüne sembol/tür/tarih filtreleri biner */
  const history = useMemo(() => {
    const q = histQuery.trim().toLocaleUpperCase('tr')
    return filteredTrades.filter((t) => {
      if (histSide && t.side !== histSide) return false
      if (histFrom && t.trade_date < histFrom) return false
      if (histTo && t.trade_date > histTo) return false
      if (q) {
        const sym = (t.assets?.symbol ?? '').toLocaleUpperCase('tr')
        const acc = (t.accounts?.name ?? '').toLocaleUpperCase('tr')
        if (!sym.includes(q) && !acc.includes(q)) return false
      }
      return true
    })
  }, [filteredTrades, histQuery, histSide, histFrom, histTo])

  const histTotals = useMemo(() => {
    let buy = 0
    let sell = 0
    for (const t of history) {
      if (t.side === 'alis') buy += Number(t.amount_try)
      else sell += Number(t.amount_try)
    }
    return { buy, sell }
  }, [history])

  const histFiltered = Boolean(histQuery || histSide || histFrom || histTo)

  const openForm = (t: TradeWithRefs | 'new') => {
    setModal(t)
    setFormError(null)
    if (t === 'new') {
      setSide('alis')
      setQty('')
      setUnit('')
      setAmount('')
      setOrderAmount('')
      setCurrency('TRY')
    } else {
      setSide(t.side)
      setQty(String(t.quantity))
      setUnit(String(t.unit_price))
      setAmount(String(t.amount))
      setOrderAmount('')
      setCurrency(t.currency)
    }
  }

  /**
   * Adet ya da birim fiyat değişince tutarı tazeler. Kullanıcı tutarı elle
   * değiştirdiyse (önceki çarpımdan sapmışsa) dokunmaz — emir ekranındaki
   * gerçekleşen tutar çarpımdan birkaç kuruş farklı olabiliyor.
   */
  const syncAmount = (nextQty: string, nextUnit: string) => {
    const auto = product(nextQty, nextUnit)
    const untouched = !amount || Math.abs(parseAmount(amount) - product(qty, unit)) < 0.005
    if (auto > 0 && untouched) setAmount(String(Number(auto.toFixed(2))).replace('.', ','))
  }

  /**
   * Serbest fonlarda küsuratlı pay yok: emir tutarıyla alınabilen tam pay
   * kadar alınır, artan tutar hesaba iade edilir. Emir tutarı + birim fiyat
   * girildiğinde adet ve gerçekleşen tutar buradan doldurulur.
   */
  const applyOrderAmount = (nextOrder: string, nextUnit: string) => {
    const order = parseAmount(nextOrder)
    const price = parseAmount(nextUnit)
    if (order <= 0 || price <= 0) return
    const shares = Math.floor(order / price)
    if (shares <= 0) return
    setQty(String(shares))
    setAmount(String(Number((shares * price).toFixed(2))).replace('.', ','))
  }

  const orderRefund = (() => {
    const order = parseAmount(orderAmount)
    const price = parseAmount(unit)
    if (order <= 0 || price <= 0) return null
    const shares = Math.floor(order / price)
    return { shares, refund: order - shares * price }
  })()

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const symbol = String(fd.get('symbol') ?? '').trim().toUpperCase()
    const kind = String(fd.get('kind') ?? 'fon') as AssetKind
    const quantity = parseAmount(qty)
    const unitPrice = parseAmount(unit)
    const total = parseAmount(amount) || quantity * unitPrice

    if (!symbol) return setFormError('Sembol gerekli.')
    if (quantity <= 0) return setFormError('Adet sıfırdan büyük olmalı.')
    if (unitPrice <= 0) return setFormError('Birim fiyat sıfırdan büyük olmalı.')

    setSaving(true)
    try {
      const asset = await ensureAsset(symbol, kind)
      const values = {
        user_id: user.id,
        account_id: String(fd.get('account_id') ?? '') || null,
        asset_id: asset?.id ?? null,
        side,
        trade_date: String(fd.get('trade_date') ?? todayISO()),
        quantity,
        unit_price: unitPrice,
        amount: total,
        currency,
        fx_rate: parseAmount(String(fd.get('fx_rate') ?? '1')) || 1,
        note: String(fd.get('note') ?? '').trim() || null,
      }
      if (modal === 'new') await trades.insert(values)
      else await trades.update((modal as TradeWithRefs).id, values)
      setModal(null)
      setFormError(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const editing = modal && modal !== 'new' ? modal : null
  const autoAmount = product(qty, unit)
  const diff = parseAmount(amount) - autoAmount

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alım / Satım"
        subtitle={
          latestDate
            ? `Kâr/zarar ${format(parseISO(latestDate), 'd MMMM yyyy', { locale: tr })} fiyatlarına göre`
            : 'Her işlem ayrı kayıt — üst üste yazmaz'
        }
        actions={
          isOwn && (
            <button className="btn-primary" onClick={() => openForm('new')}>
              + İşlem ekle
            </button>
          )
        }
      />

      {trades.error && <ErrorBox message={trades.error} />}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted">Hesap:</label>
        <select
          className="min-w-[220px]"
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
        >
          <option value="">Tüm hesaplar</option>
          {regularAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          {ipoAccounts.length > 0 && (
            <optgroup label="Halka arz hesapları">
              {ipoAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
          {hasOrphanTrades && <option value={NO_ACCOUNT}>Hesap seçilmemiş</option>}
        </select>
        {accountFilter && (
          <button className="btn-ghost text-xs" onClick={() => setAccountFilter('')}>
            ✕ Filtreyi kaldır
          </button>
        )}
        {accountFilter && (
          <span className="text-xs text-muted">
            Özetler ve geçmiş yalnızca bu hesabın işlemlerini gösteriyor.
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Toplam maliyet" value={totals.costBasis} />
        <StatCard
          title="Güncel değer"
          value={totals.value}
          hint={totals.unpriced > 0 ? `${totals.unpriced} kalemin güncel fiyatı yok` : undefined}
        />
        <StatCard
          title="Açık kâr / zarar"
          value={totals.unrealized}
          tone={totals.unrealized >= 0 ? 'pos' : 'neg'}
          hint={
            totals.costBasis > 0
              ? `${formatPercent((totals.unrealized / totals.costBasis) * 100)} · vergi öncesi`
              : undefined
          }
        />
        <StatCard
          title="Vergi sonrası değer"
          value={totals.netValue}
          hint={
            totals.potentialTax > 0
              ? `Bugün satsan ${formatTRY(totals.potentialTax)} vergi çıkar`
              : 'Ödenecek vergi yok'
          }
        />
        <StatCard
          title="Gerçekleşen kâr (net)"
          value={totals.realizedNet}
          tone={totals.realizedNet >= 0 ? 'pos' : 'neg'}
          hint={
            totals.realizedTax > 0
              ? `Brüt ${formatTRY(totals.realized)} − ${formatTRY(totals.realizedTax)} vergi`
              : 'Satılan paylardan'
          }
        />
        <StatCard
          title="Toplam vergi"
          value={totals.totalTax}
          tone={totals.totalTax > 0 ? 'neg' : 'neutral'}
          hint={`Ödenen ${formatTRY(totals.realizedTax)} + ödenecek ${formatTRY(totals.potentialTax)} · %${(DEFAULT_TAX_RATE * 100).toFixed(1).replace('.', ',')}`}
        />
      </div>

      <Card className="!py-3">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <span className="text-xs text-muted">Vergiler düşülünce toplam kazanç </span>
            <span
              className={`num text-lg font-semibold ${
                totals.netProfit >= 0 ? 'text-pos' : 'text-neg'
              }`}
            >
              {formatTRY(totals.netProfit)}
            </span>
          </div>
          <p className="text-xs text-muted">
            Gerçekleşen net {formatTRY(totals.realizedNet)} + açık pozisyon net{' '}
            {formatTRY(totals.unrealized - totals.potentialTax)}
          </p>
        </div>
      </Card>

      <Card
        title="Pozisyonlar"
        className="p-0 overflow-x-auto"
        actions={
          <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1 mr-4">
            {[
              { key: false, label: 'Sembol bazında' },
              { key: true, label: 'Hesap bazında' },
            ].map((o) => (
              <button
                key={String(o.key)}
                onClick={() => setByAccount(o.key)}
                className={`px-2.5 py-1 rounded-md text-xs ${
                  byAccount === o.key ? 'bg-surface2 text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
      >
        {trades.loading ? (
          <Spinner />
        ) : holdings.length === 0 ? (
          <Empty>Henüz işlem yok. Sağ üstteki düğmeyle ilk alımını gir.</Empty>
        ) : (
          <table className="w-full min-w-[820px]">
            <thead>
              <tr>
                <th className="th">Sembol</th>
                <th className="th text-right">Pozisyon</th>
                <th className="th text-right">Maliyet</th>
                <th className="th text-right">Değer</th>
                <th className="th text-right">Kâr / Zarar</th>
              </tr>
            </thead>
            <tbody>
              {openHoldings.map((h) => (
                <tr key={`${h.symbol}-${h.account ?? ''}`} className="hover:bg-surface2/50">
                  <td
                    className="td"
                    title={`${h.buyCount} alım${h.sellCount > 0 ? ` · ${h.sellCount} satış` : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{h.symbol}</span>
                      <span className="text-[11px] uppercase tracking-wide text-muted">
                        {h.kind}
                      </span>
                      {h.oversold && <Badge tone="warn">eksik alım</Badge>}
                    </div>
                    {byAccount && <div className="text-xs text-muted">{h.account}</div>}
                  </td>
                  <td className="td text-right">
                    <div className="num">{formatNumber(h.quantity, 4)}</div>
                    <div className="text-xs text-muted num">ort. {formatNumber(h.avgCost, 4)}</div>
                  </td>
                  <td className="td text-right num">{formatTRY(h.costBasis)}</td>
                  <td className="td text-right">
                    {h.value != null ? (
                      <>
                        <div className="num font-medium">{formatTRY(h.value)}</div>
                        <div className="text-xs text-muted num">@ {formatNumber(h.price, 4)}</div>
                      </>
                    ) : (
                      <span className="text-xs text-muted">fiyat yok</span>
                    )}
                  </td>
                  <td className="td text-right">
                    {h.unrealized != null ? (
                      <div
                        className={`num font-medium ${h.unrealized >= 0 ? 'text-pos' : 'text-neg'}`}
                      >
                        {formatTRY(h.unrealized)}
                        {h.unrealizedPct != null && (
                          <span className="ml-1 text-xs font-normal">
                            {formatPercent(h.unrealizedPct)}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                    {h.realized !== 0 && (
                      <div className="text-xs text-muted num">
                        gerçekleşen {formatTRY(h.realizedNet)}
                      </div>
                    )}
                    {h.potentialTax != null && h.potentialTax > 0 && (
                      <div className="text-xs text-muted num">
                        vergi −{formatTRY(h.potentialTax)} · net {formatTRY(h.netValue ?? 0)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {closedHoldings.length > 0 && (
                <>
                  <tr>
                    <td colSpan={5} className="px-4 py-2 border-t border-border">
                      <button
                        type="button"
                        className="text-xs text-muted hover:text-ink"
                        onClick={() => setShowClosed((v) => !v)}
                      >
                        {showClosed ? '▾' : '▸'} Kapanan pozisyonlar ({closedHoldings.length})
                      </button>
                    </td>
                  </tr>
                  {showClosed &&
                    closedHoldings.map((h) => (
                      <tr
                        key={`${h.symbol}-${h.account ?? ''}-kapali`}
                        className="hover:bg-surface2/50 opacity-70"
                      >
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{h.symbol}</span>
                            <span className="text-[11px] uppercase tracking-wide text-muted">
                              {h.kind}
                            </span>
                          </div>
                          {byAccount && <div className="text-xs text-muted">{h.account}</div>}
                        </td>
                        <td className="td text-right text-xs text-muted">
                          kapandı · {h.buyCount} alım / {h.sellCount} satış
                        </td>
                        <td className="td text-right num text-muted">—</td>
                        <td className="td text-right num text-muted">—</td>
                        <td className="td text-right">
                          <span
                            className={`num ${h.realizedNet >= 0 ? 'text-pos' : 'text-neg'}`}
                          >
                            {formatTRY(h.realizedNet)}
                          </span>
                          {h.realizedTax > 0 && (
                            <div className="text-xs text-muted num">
                              vergi −{formatTRY(h.realizedTax)}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                </>
              )}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="İşlem geçmişi" className="p-0 overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border">
          <input
            className="w-48 text-sm"
            placeholder="Sembol ya da hesap ara"
            value={histQuery}
            onChange={(e) => setHistQuery(e.target.value)}
          />
          <div className="inline-flex rounded-lg border border-border bg-surface p-1 gap-1">
            {(
              [
                ['', 'Tümü'],
                ['alis', 'Alış'],
                ['satis', 'Satış'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => setHistSide(v as '' | TradeSide)}
                className={`px-2.5 py-1 rounded-md text-xs ${
                  histSide === v ? 'bg-surface2 text-ink' : 'text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="date"
            className="text-sm"
            title="Başlangıç tarihi"
            value={histFrom}
            onChange={(e) => setHistFrom(e.target.value)}
          />
          <span className="text-xs text-muted">–</span>
          <input
            type="date"
            className="text-sm"
            title="Bitiş tarihi"
            value={histTo}
            onChange={(e) => setHistTo(e.target.value)}
          />
          {histFiltered && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                setHistQuery('')
                setHistSide('')
                setHistFrom('')
                setHistTo('')
              }}
            >
              ✕ Temizle
            </button>
          )}
          <span className="ml-auto text-xs text-muted num">
            {history.length} işlem · Alış {formatTRY(histTotals.buy)}
            {histTotals.sell > 0 && <> · Satış {formatTRY(histTotals.sell)}</>}
          </span>
        </div>
        {trades.loading ? (
          <Spinner />
        ) : history.length === 0 ? (
          <Empty>
            {histFiltered || accountFilter ? 'Filtreye uyan kayıt yok.' : 'Kayıt yok.'}
          </Empty>
        ) : (
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Tarih</th>
                <th className="th">İşlem</th>
                <th className="th">Sembol</th>
                <th className="th text-right">Adet × Birim</th>
                <th className="th text-right">Tutar</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id} className="hover:bg-surface2/50">
                  <td className="td whitespace-nowrap text-muted">
                    {format(parseISO(t.trade_date), 'd MMM yyyy', { locale: tr })}
                  </td>
                  <td className="td">
                    <Badge tone={t.side === 'alis' ? 'accent' : 'pos'}>
                      {t.side === 'alis' ? 'Alış' : 'Satış'}
                    </Badge>
                  </td>
                  <td className="td">
                    <div className="font-medium">
                      {t.assets?.symbol ?? '—'}
                      {isIpoTrade(t) && (
                        <span className="ml-2 align-middle">
                          <Badge tone="accent">arz</Badge>
                        </span>
                      )}
                    </div>
                    {t.accounts?.name && (
                      <div className="text-xs text-muted">{t.accounts.name}</div>
                    )}
                  </td>
                  <td className="td text-right num whitespace-nowrap">
                    {formatNumber(Number(t.quantity), 4)}{' '}
                    <span className="text-muted">×</span> {formatNumber(Number(t.unit_price), 6)}
                  </td>
                  <td className="td text-right num font-medium">
                    {formatTRY(Number(t.amount_try))}
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    {isIpoTrade(t) ? (
                      <span className="text-xs text-muted" title="Halka Arz sayfasından düzeltilir">
                        Halka Arz'dan
                      </span>
                    ) : isOwn ? (
                      <div className="inline-flex gap-1">
                        <button className="btn-ghost text-xs" onClick={() => openForm(t)}>
                          Düzenle
                        </button>
                        <button
                          className="btn-danger text-xs"
                          onClick={() => confirm('İşlem silinsin mi?') && trades.remove(t.id)}
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

      <Modal
        open={modal !== null}
        title={editing ? 'İşlemi düzenle' : 'Yeni işlem'}
        onClose={() => setModal(null)}
      >
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">İşlem</label>
              <div className="inline-flex w-full rounded-lg border border-border bg-surface2 p-1 gap-1">
                {(['alis', 'satis'] as TradeSide[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSide(s)}
                    className={`flex-1 rounded-md px-2 py-1.5 text-sm ${
                      side === s ? 'bg-surface text-ink' : 'text-muted hover:text-ink'
                    }`}
                  >
                    {s === 'alis' ? 'Alış' : 'Satış'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Tarih</label>
              <input
                type="date"
                name="trade_date"
                className="w-full"
                defaultValue={editing?.trade_date ?? todayISO()}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Sembol</label>
              <input
                list="trade-symbols"
                name="symbol"
                className="w-full uppercase"
                placeholder="DFI"
                defaultValue={editing?.assets?.symbol ?? ''}
                required
              />
              <datalist id="trade-symbols">
                {assets.map((a) => (
                  <option key={a.id} value={a.symbol} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="label">Tür</label>
              <select name="kind" className="w-full" defaultValue={editing?.assets?.kind ?? 'fon'}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Hesap</label>
            <select
              name="account_id"
              className="w-full"
              defaultValue={
                editing?.account_id ?? (accountFilter !== NO_ACCOUNT ? accountFilter : '')
              }
            >
              <option value="">Hesap seç…</option>
              {regularAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              {ipoAccounts.length > 0 && (
                <optgroup label="Halka arz hesapları">
                  {ipoAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Adet</label>
              <input
                className="w-full num"
                inputMode="decimal"
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value)
                  syncAmount(e.target.value, unit)
                }}
                required
              />
            </div>
            <div>
              <label className="label">Birim fiyat</label>
              <input
                className="w-full num"
                inputMode="decimal"
                value={unit}
                onChange={(e) => {
                  setUnit(e.target.value)
                  syncAmount(qty, e.target.value)
                }}
                required
              />
            </div>
            <div>
              <label className="label">Tutar</label>
              <input
                className="w-full num"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface2/50 p-3">
            <label className="label">Emir tutarı (tam pay hesabı)</label>
            <input
              className="w-full num"
              inputMode="decimal"
              placeholder="Örn. 3.005,36"
              value={orderAmount}
              onChange={(e) => {
                setOrderAmount(e.target.value)
                applyOrderAmount(e.target.value, unit)
              }}
            />
            <p className="mt-1 text-xs text-muted">
              {orderRefund && orderRefund.shares > 0 ? (
                <>
                  {orderRefund.shares} tam pay alınır ·{' '}
                  <span className="text-pos">{formatTRY(orderRefund.refund)} iade</span>
                </>
              ) : (
                'Emir tutarını ve birim fiyatı yaz — küsuratsız pay adedi ve iade hesaplansın.'
              )}
            </p>
          </div>

          {autoAmount > 0 && Math.abs(diff) >= 0.01 && (
            <p className="text-xs text-muted">
              Adet × birim fiyat = {formatTRY(autoAmount)} · girdiğin tutarla fark{' '}
              <span className={diff >= 0 ? 'text-pos' : 'text-neg'}>{formatTRY(diff)}</span>. Emir
              ekranındaki gerçekleşen tutarı yazdıysan bu fark normaldir.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Para birimi</label>
              <select
                className="w-full"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
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
                className="w-full num"
                inputMode="decimal"
                disabled={currency === 'TRY'}
                defaultValue={editing?.fx_rate ?? 1}
              />
            </div>
          </div>

          <div>
            <label className="label">Not</label>
            <input name="note" className="w-full" defaultValue={editing?.note ?? ''} />
          </div>

          {formError && <ErrorBox message={formError} />}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
              Vazgeç
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
