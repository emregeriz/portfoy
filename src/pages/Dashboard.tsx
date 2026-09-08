import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { usePortfolio } from '../hooks/usePortfolio'
import UserTabs from '../components/UserTabs'
import StatCard from '../components/StatCard'
import NetWorthChart from '../components/NetWorthChart'
import AllocationPie from '../components/AllocationPie'
import AccountBar from '../components/AccountBar'
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatPercent, formatTRY } from '../lib/currency'
import { DEFAULT_TAX_RATE } from '../lib/holdings'

/** Fon - Hisse grafiğinde başta görünen kalem sayısı */
const FUNDS_SHOWN = 10

export default function Dashboard() {
  const { profiles, user } = useAuth()
  const [scope, setScope] = useState<string>(user?.id ?? '')
  /** Pozisyon grafiğinde vergi sonrası çizgisi — varsayılan gizli */
  const [showNetLine, setShowNetLine] = useState(false)
  /** Fon-hisse grafiğinde ilk 10'dan fazlasını göster */
  const [showAllFunds, setShowAllFunds] = useState(false)
  /** Fon-hisse kartında pozisyon dökümü — adet, değer, kâr */
  const [showFundDetail, setShowFundDetail] = useState(false)

  const effectiveScope = scope || user?.id || ''

  // Bütün sayılar tek yerden: hooks/usePortfolio (Hedef sayfası da aynı kaynağı okur)
  const {
    error, last, netChange, posLoading, latestDate, refreshing, refresh, priceError, holdings, tradeTotals, tradeSeries, byKind, byAccount, fundProfit, fundProfitTotal, cashTotals, cashTotal, totalWaiting, blockedTotal, openDebtTotal, dueSoon, todayStr, live, liveAssets, showLive, totalDebt, liveNet, liveChange,
  } = usePortfolio(effectiveScope)

  /** Grafikte önce mutlak değeri en büyük ilk 10 kalem; sıralama kâr düzeninde kalır */
  const fundProfitShown = useMemo(() => {
    if (showAllFunds || fundProfit.length <= FUNDS_SHOWN) return fundProfit
    return [...fundProfit]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, FUNDS_SHOWN)
      .sort((a, b) => b.value - a.value)
  }, [fundProfit, showAllFunds])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        subtitle={
          last
            ? `Son güncelleme: ${format(parseISO(last.snapshot_date), 'd MMMM yyyy', { locale: tr })}`
            : 'Henüz kayıt yok'
        }
        actions={
          <Link to="/trades" className="btn-primary">
            + İşlem ekle
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <UserTabs
          profiles={profiles}
          currentUserId={user?.id}
          value={effectiveScope}
          onChange={setScope}
        />
      </div>

      {error && <ErrorBox message={error} />}

      {dueSoon.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <div className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-1">
            Yaklaşan ödemeler
          </div>
          <ul className="space-y-0.5 text-xs">
            {dueSoon.map((l) => {
              const overdue = (l.due_date ?? '') < todayStr
              return (
                <li key={l.id} className="flex justify-between gap-3">
                  <span>
                    {l.title}
                    {l.counterparty ? ` · ${l.counterparty}` : ''}
                  </span>
                  <span className={`num ${overdue ? 'text-neg' : 'text-muted'}`}>
                    {formatTRY(Number(l.amount) * Number(l.fx_rate ?? 1))} ·{' '}
                    {overdue
                      ? 'gecikti'
                      : format(parseISO(l.due_date as string), 'd MMM', { locale: tr })}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Toplam Varlık"
          value={liveAssets}
          hint={
            [
              tradeTotals.value > 0 ? `${formatTRY(tradeTotals.value)} pozisyon` : null,
              cashTotal > 0 ? `${formatTRY(cashTotal)} nakit` : null,
            ]
              .filter(Boolean)
              .join(' · ') + (tradeTotals.value > 0 || cashTotal > 0 ? ' dahil' : '') || undefined
          }
        />
        <StatCard
          title="Toplam Borç"
          value={totalDebt}
          tone={totalDebt > 0 ? 'neg' : 'neutral'}
        />
        <StatCard
          title="Net Değer"
          value={liveNet ?? last?.net_worth_try ?? 0}
          change={netChange}
          tone={(liveNet ?? 0) >= 0 ? 'pos' : 'neg'}
        />
        <StatCard
          title="Vergi Sonrası Kazanç"
          value={tradeTotals.netProfit}
          tone={tradeTotals.netProfit >= 0 ? 'pos' : 'neg'}
          hint={
            tradeTotals.totalTax > 0
              ? `${formatTRY(tradeTotals.totalTax)} vergi düşüldü`
              : 'Alım/satım kaydı yok'
          }
        />
      </div>

      {showLive && (
        <Card
          title="Şu Anki Tahmini Değer"
          actions={
            <button className="btn-ghost text-xs" onClick={() => void refresh()} disabled={refreshing} type="button">
              {refreshing ? 'Güncelleniyor…' : '↻ Fiyatları güncelle'}
            </button>
          }
        >
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-2xl font-semibold text-ink">{formatTRY(liveNet ?? 0)}</p>
              <p className="text-xs text-muted">
                Net değer · son kayıt {formatTRY(last?.net_worth_try ?? 0)}
                {liveChange && liveChange.percent !== null && (
                  <span className={liveChange.absolute >= 0 ? ' text-pos' : ' text-neg'}>
                    {' '}({formatPercent(liveChange.percent)})
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-lg text-ink">{formatTRY(liveAssets)}</p>
              <p className="text-xs text-muted">Toplam varlık</p>
            </div>
            {openDebtTotal > 0 && (
              <div>
                <p className="text-lg text-neg">−{formatTRY(openDebtTotal)}</p>
                <p className="text-xs text-muted">Açık borç & fatura</p>
              </div>
            )}
            {tradeTotals.value > 0 && (
              <div>
                <p className="text-lg text-ink">{formatTRY(tradeTotals.value)}</p>
                <p className="text-xs text-muted">
                  Fon &amp; hisse pozisyonları ·{' '}
                  <span className={tradeTotals.unrealized >= 0 ? 'text-pos' : 'text-neg'}>
                    {formatTRY(tradeTotals.unrealized)} kâr
                  </span>
                </p>
              </div>
            )}
            {cashTotals.cash > 0 && (
              <div>
                <p className="text-lg text-ink">{formatTRY(cashTotals.cash)}</p>
                <p className="text-xs text-muted">
                  Kendi hesaplarındaki nakit
                  {cashTotals.todayNema > 0 && (
                    <span className="text-pos"> · bugün +{formatTRY(cashTotals.todayNema)} nema</span>
                  )}
                  {cashTotals.totalNema > 0 && (
                    <span> · toplam {formatTRY(cashTotals.totalNema)} nema</span>
                  )}
                </p>
              </div>
            )}
            {totalWaiting > 0 && (
              <div>
                <p className="text-lg text-pos">{formatTRY(totalWaiting)}</p>
                <p className="text-xs text-muted">
                  <Link to="/ipo" className="hover:text-ink">Halka arz iadesi</Link> · çekilmeyi bekliyor
                </p>
              </div>
            )}
            {blockedTotal > 0 && (
              <div>
                <p className="text-lg text-amber-600 dark:text-amber-400">{formatTRY(blockedTotal)}</p>
                <p className="text-xs text-muted">
                  <Link to="/ipo" className="hover:text-ink">Arzda bloke</Link> · dağıtım bekliyor
                </p>
              </div>
            )}
            <div className="text-xs text-muted">
              {live && (
                <p>
                  {live.priced}/{live.count} kalem güncel fiyatla değerlendi
                </p>
              )}
              <p>Fiyat tarihi: {latestDate ?? '—'}</p>
            </div>
          </div>
          {priceError && <p className="mt-2 text-xs text-neg">{priceError}</p>}
        </Card>
      )}

      {tradeSeries.length > 0 && (
        <Card
          title="Pozisyon Değeri (alım / satım)"
          actions={
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => setShowNetLine((v) => !v)}
            >
              {showNetLine ? 'Vergi sonrasını gizle' : 'Vergi sonrasını göster'}
            </button>
          }
        >
          <NetWorthChart
            data={tradeSeries.map((p) => ({
              date: p.date,
              deger: p.value,
              vergiSonrasi: p.netValue,
            }))}
            series={
              showNetLine
                ? [
                    { key: 'deger', label: 'Değer', color: '#22c55e' },
                    { key: 'vergiSonrasi', label: 'Vergi sonrası', color: '#f59e0b' },
                  ]
                : [{ key: 'deger', label: 'Değer', color: '#22c55e' }]
            }
          />
          {showNetLine && (
            <p className="mt-2 text-xs text-muted">
              Turuncu çizgi, o gün satılsaydı fonlardan %{(DEFAULT_TAX_RATE * 100).toFixed(1).replace('.', ',')}{' '}
              stopaj kesildikten sonra cebe kalacak tutarı gösterir — hisselerden ve stopajsız
              işaretlenmiş hisse senedi yoğun fonlardan kesinti yapılmaz.
              Noktalar işlem tarihlerinden geçer; ara günler için geçmiş fiyat tutulmuyor.
            </p>
          )}
        </Card>
      )}

      {fundProfit.length > 0 && (
        <Card
          title="Fon - Hisse Kâr / Zarar"
          actions={
            <span
              className={`num text-sm font-semibold ${
                fundProfitTotal >= 0 ? 'text-pos' : 'text-neg'
              }`}
            >
              Toplam {formatTRY(fundProfitTotal)}
            </span>
          }
        >
          <AccountBar data={fundProfitShown} />
          {showFundDetail && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className="th">Sembol</th>
                    <th className="th text-right">Adet</th>
                    <th className="th text-right">Güncel fiyat</th>
                    <th className="th text-right">Değer</th>
                    <th className="th text-right">Maliyet</th>
                    <th className="th text-right">Kâr / Zarar</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings
                    .filter((h) => h.quantity > 0)
                    .map((h) => (
                      <tr key={h.symbol} className="hover:bg-surface2/50">
                        <td className="td font-medium">
                          {h.symbol}
                          <span className="ml-2 text-xs text-muted">{h.kind}</span>
                        </td>
                        <td className="td text-right num">{formatNumber(h.quantity, 4)}</td>
                        <td className="td text-right num text-muted">
                          {h.price != null ? formatNumber(h.price, 4) : '—'}
                        </td>
                        <td className="td text-right num font-medium">
                          {formatTRY(h.value ?? h.costBasis)}
                          {h.price == null && (
                            <span className="ml-1 text-xs text-muted font-normal">maliyet</span>
                          )}
                        </td>
                        <td className="td text-right text-muted">
                          <div className="num">{formatTRY(h.costBasis)}</div>
                          <div className="text-xs num">ort. {formatNumber(h.avgCost, 4)}</div>
                        </td>
                        <td className="td text-right num">
                          {h.unrealized != null ? (
                            <span className={h.unrealized >= 0 ? 'text-pos' : 'text-neg'}>
                              {formatTRY(h.unrealized)}
                              {h.unrealizedPct != null && (
                                <span className="ml-1 text-xs">
                                  {formatPercent(h.unrealizedPct)}
                                </span>
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
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              Her kalemin gerçekleşen ve açık kârı toplanır; fonlarda stopaj düşülür. Hisselerde
              ve stopajsız işaretlenmiş hisse senedi yoğun fonlarda vergi yoktur.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setShowFundDetail((v) => !v)}
              >
                {showFundDetail ? 'Detayı gizle' : 'Detay'}
              </button>
              {fundProfit.length > FUNDS_SHOWN && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setShowAllFunds((v) => !v)}
                >
                  {showAllFunds
                    ? 'Daha az göster'
                    : `Daha fazla göster (${fundProfit.length - FUNDS_SHOWN})`}
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Varlık Dağılımı">
          {posLoading ? <Spinner /> : byKind.length ? <AllocationPie data={byKind} /> : <Empty>Henüz kalem yok.</Empty>}
        </Card>
        <Card title="Hesap Bazlı Dağılım">
          {posLoading ? <Spinner /> : byAccount.length ? <AccountBar data={byAccount} /> : <Empty>Henüz kalem yok.</Empty>}
        </Card>
      </div>
    </div>
  )
}
