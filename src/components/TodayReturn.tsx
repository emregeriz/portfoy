import { useState } from 'react'
import { Link } from 'react-router-dom'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useTodayReturn } from '../hooks/useTodayReturn'
import { usePeriodReturn, PERIODS, PERIOD_LABEL, type ReturnPeriod } from '../hooks/usePeriodReturn'
import { formatNumber, formatPercent, formatTRY } from '../lib/currency'
import { todayISO } from '../lib/calc'

/**
 * Üst çubuktaki "bugünün getirisi" rozeti.
 *
 * Kâr varsa yeşil, zarar varsa kırmızı yanar; tutar rozetin üzerinde yazar.
 * Tıklayınca kırılım açılır: fon/hisse fiyat hareketi, halka arz, nema,
 * temettü ve o gün gerçekleşen satışlar. Satışlar hesap hesap listelenir —
 * aynı kâğıdı farklı hesaplardan farklı fiyata satmış olabilirsin, kazanç
 * her hesabın kendi fiyatından ölçülür.
 *
 * "En çok oynayan" listesinde tutarın yanındaki yüzde **kâğıdın kendi
 * günlük hareketidir**, gün kârının pozisyona oranı değil. İkisi satış olan
 * günlerde birbirinden ayrılır: 190'dan açan kâğıdı 206'dan satıp gün 191'de
 * kapanırsa kazancın büyük kısmı satış priminden gelir, kâğıt ise yalnızca
 * %0,7 oynamıştır. Satış payı bu yüzden "satıştan +₺…" olarak ayrı yazılır;
 * gün kârının gün başı pozisyona oranı tutarın üzerinde ipucu olarak durur.
 */
/** Kırılımda başta görünen kalem sayısı — gerisi "daha fazla göster" ile açılır */
const MOVERS_SHOWN = 10

export default function TodayReturn() {
  const { user } = useAuth()
  const {
    total,
    priceDelta,
    ipoDelta,
    nema,
    dividend,
    ipoLots,
    priceDate,
    movers,
    items,
    hasPricesToday,
    lastPriceDay,
    unmeasured,
    loading,
    error,
    reload,
  } = useTodayReturn(user?.id)
  const [open, setOpen] = useState(false)
  const [showAllMovers, setShowAllMovers] = useState(false)
  /** null = bugün; diğerleri haftalık/aylık/3 aylık/yıllık */
  const [period, setPeriod] = useState<ReturnPeriod | null>(null)
  const periodData = usePeriodReturn(user?.id)
  const sel = period ? (periodData.results?.[period] ?? null) : null

  if (loading) {
    return (
      <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs text-muted border border-border">
        Bugün …
      </span>
    )
  }

  // Rozet seçili dönemi gösterir; dönem seçilmediyse bugünü
  const shown = sel ? sel.total : total
  const pos = shown > 0.004
  const neg = shown < -0.004
  const tone = pos
    ? 'text-pos border-pos/30 bg-pos/10'
    : neg
      ? 'text-neg border-neg/30 bg-neg/10'
      : 'text-muted border-border bg-surface2'
  const sign = pos ? '+' : neg ? '−' : ''
  const stale = priceDate && priceDate !== todayISO()
  /** O gün gerçekleşen satışlar — kazancın nereden geldiğinin en net cevabı */
  const sales = items.filter((i) => i.part === 'satis')

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border num transition-opacity hover:opacity-80 ${tone}`}
        title="Bugünün getirisi — fon/hisse + halka arz + nema"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="opacity-70 font-medium hidden sm:inline">
          {period ? PERIOD_LABEL[period] : 'Bugün'}
        </span>
        <span>
          {periodData.loading && period ? (
            '…'
          ) : (
            <>
              {pos ? '▲' : neg ? '▼' : '•'} {sign}
              {formatTRY(Math.abs(shown))}
            </>
          )}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 z-20 w-80 rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">
                {period ? `${PERIOD_LABEL[period]} getirisi` : 'Bugünün getirisi'}
              </span>
              <button
                className="text-xs text-muted hover:text-ink"
                onClick={() => void (period ? periodData.reload() : reload())}
                type="button"
              >
                ↻
              </button>
            </div>

            {/* Dönem seçici — hangi aralığın kârına bakılacağı */}
            <div className="px-3 py-2 border-b border-border flex flex-wrap gap-1">
              {([null, ...PERIODS] as (ReturnPeriod | null)[]).map((p) => (
                <button
                  key={p ?? 'gun'}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={`px-2 py-0.5 rounded-full text-[11px] border transition-colors ${
                    period === p
                      ? 'border-accent/40 bg-accent/10 text-accent font-medium'
                      : 'border-border text-muted hover:text-ink'
                  }`}
                >
                  {p ? PERIOD_LABEL[p] : 'Bugün'}
                </button>
              ))}
            </div>

            {period ? (
              <div className="px-3 py-2 space-y-1.5 text-xs">
                {periodData.loading ? (
                  <div className="text-muted py-2 text-center">Hesaplanıyor…</div>
                ) : !sel ? (
                  <div className="text-muted py-2 text-center">Veri yok.</div>
                ) : (
                  <>
                    <Row label="Fon & hisse" value={sel.priceDelta} />
                    {sel.nema !== 0 && <Row label="Nema geliri" value={sel.nema} />}
                    {sel.dividend !== 0 && <Row label="Temettü (net)" value={sel.dividend} />}
                    <div className="flex justify-between gap-3 pt-1.5 border-t border-border font-semibold text-ink">
                      <span>Toplam</span>
                      <span className={`num ${pos ? 'text-pos' : neg ? 'text-neg' : ''}`}>
                        {sign}
                        {formatTRY(Math.abs(sel.total))}
                        {sel.pct !== null && (
                          <span className="text-muted font-normal"> ({formatPercent(sel.pct)})</span>
                        )}
                      </span>
                    </div>
                    {sel.realPct !== null && (
                      <div className="flex justify-between gap-3 pt-1.5 border-t border-border">
                        <span className="text-muted">
                          Dolar bazında
                          {sel.fxPct !== null && (
                            <span className="opacity-70"> · kur {formatPercent(sel.fxPct)}</span>
                          )}
                        </span>
                        <span
                          className={`num ${
                            sel.realPct > 0 ? 'text-pos' : sel.realPct < 0 ? 'text-neg' : 'text-muted'
                          }`}
                        >
                          {formatPercent(sel.realPct)}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="px-3 py-2 space-y-1.5 text-xs">
                <Row label="Fon & hisse" value={priceDelta} />
                {(ipoLots > 0 || ipoDelta !== 0) && (
                  <Row
                    label={ipoLots > 0 ? `Halka arz (${formatNumber(ipoLots, 0)} lot)` : 'Halka arz'}
                    value={ipoDelta}
                  />
                )}
                <Row label="Nema geliri" value={nema} />
                {dividend !== 0 && <Row label="Temettü (net)" value={dividend} />}
                <div className="flex justify-between gap-3 pt-1.5 border-t border-border font-semibold text-ink">
                  <span>Toplam</span>
                  <span className={`num ${pos ? 'text-pos' : neg ? 'text-neg' : ''}`}>
                    {sign}
                    {formatTRY(Math.abs(total))}
                  </span>
                </div>
              </div>
            )}

            {!period && sales.length > 0 && (
              <div className="px-3 py-2 border-t border-border space-y-1.5 max-h-56 overflow-y-auto">
                <div className="text-[11px] uppercase tracking-wide text-muted">
                  Bugün satılanlar
                  <span className="ml-1 normal-case tracking-normal opacity-70">
                    · toplama dahil
                  </span>
                </div>
                {sales.map((s) => (
                  <div key={s.key} className="flex justify-between gap-3 text-xs">
                    <span className="text-ink min-w-0">
                      {s.symbol}
                      {s.account && <span className="text-muted"> · {s.account}</span>}
                      <span className="block text-[11px] text-muted num">
                        {formatNumber(s.qty, 0)} × {formatNumber(s.to)}
                        {s.from != null && (
                          <>
                            {' '}
                            ← {formatNumber(s.from)}
                            <span className="ml-1 opacity-70">
                              {s.sameDay
                                ? 'alış'
                                : s.vsIpoPrice
                                  ? 'arz fiyatı'
                                  : 'önceki kapanış'}
                            </span>
                          </>
                        )}
                      </span>
                    </span>
                    <span className={`num shrink-0 ${s.delta >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {s.delta >= 0 ? '+' : '−'}
                      {formatTRY(Math.abs(s.delta))}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!period && movers.length > 0 && (
              <div className="px-3 py-2 border-t border-border space-y-1 max-h-72 overflow-y-auto">
                <div className="text-[11px] uppercase tracking-wide text-muted">En çok oynayan</div>
                {(showAllMovers ? movers : movers.slice(0, MOVERS_SHOWN)).map((m) => (
                  <div key={`${m.source}:${m.symbol}`} className="flex justify-between gap-3 text-xs">
                    <span className="text-ink min-w-0">
                      {m.symbol}
                      {m.source === 'ipo' && <span className="ml-1 text-muted">arz</span>}
                      {m.vsIpoPrice && (
                        <span
                          className="ml-1 text-muted"
                          title="İlk işlem günü — halka arz fiyatına göre"
                        >
                          ilk gün
                        </span>
                      )}
                      {/* Yüzde kâğıdın kendi günlük hareketi; satış primi ayrı
                          yazılır, yoksa "hisse bu kadar mı yükselmiş" sanılıyor */}
                      {(m.pricePct !== null || m.saleDelta !== 0) && (
                        <span className="block text-[11px] text-muted num">
                          {m.pricePct !== null && (
                            <span
                              title={
                                m.vsIpoPrice
                                  ? 'Arz fiyatına göre günün fiyat hareketi'
                                  : 'Önceki kapanışa göre günün fiyat hareketi'
                              }
                            >
                              fiyat {formatPercent(m.pricePct)}
                            </span>
                          )}
                          {m.saleDelta !== 0 && (
                            <span title="Bugün sattığın paydan gelen kısım — yandaki toplamın içinde">
                              {m.pricePct !== null && ' · '}
                              satıştan {m.saleDelta >= 0 ? '+' : '−'}
                              {formatTRY(Math.abs(m.saleDelta))}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    <span
                      className={`num shrink-0 ${m.delta >= 0 ? 'text-pos' : 'text-neg'}`}
                      title={
                        m.pct !== null
                          ? `Gün başı pozisyona göre ${formatPercent(m.pct)}`
                          : undefined
                      }
                    >
                      {m.delta >= 0 ? '+' : '−'}
                      {formatTRY(Math.abs(m.delta))}
                    </span>
                  </div>
                ))}
                {movers.length > MOVERS_SHOWN && (
                  <button
                    type="button"
                    className="w-full text-center text-[11px] text-muted hover:text-ink pt-1"
                    onClick={() => setShowAllMovers((v) => !v)}
                  >
                    {showAllMovers
                      ? 'Daha az göster'
                      : `Daha fazla göster (${movers.length - MOVERS_SHOWN})`}
                  </button>
                )}
              </div>
            )}

            <div className="px-3 py-2 border-t border-border text-[11px] text-muted space-y-1">
              {period && sel && (
                <div>
                  {format(parseISO(sel.from), 'd MMMM yyyy', { locale: tr })} → bugün. Araya konan
                  para kâr sayılmaz: dönem içi alımlar maliyete, satışlar gelire yazılır.
                  {sel.unmeasured > 0 && ` ${sel.unmeasured} kalem ölçülemedi — dönem başı fiyatı yok.`}
                </div>
              )}
              {period && periodData.error && <div className="text-neg">{periodData.error}</div>}
              {!period && (
                <div>
                  {!hasPricesToday ? (
                    <>
                      Bugün için fiyat gelmedi — fiyatlar hafta içi 10:00 ve 19:00'da güncellenir.
                      {lastPriceDay && (
                        <>
                          {' '}
                          Son fiyat günü{' '}
                          {format(parseISO(lastPriceDay.date), 'd MMMM', { locale: tr })}:{' '}
                          {lastPriceDay.total >= 0 ? '+' : '−'}
                          {formatTRY(Math.abs(lastPriceDay.total))}.
                        </>
                      )}
                    </>
                  ) : priceDate ? (
                    <>
                      Fiyatlar: {format(parseISO(priceDate), 'd MMMM yyyy', { locale: tr })}
                      {stale && ' — bugünden eski.'}
                    </>
                  ) : (
                    'Fiyat geçmişi yok; yalnızca nakit gelirler sayıldı.'
                  )}
                </div>
              )}
              {!period && unmeasured > 0 && (
                <div>
                  {unmeasured} kalem sayılamadı — önceki gün fiyatı yok. Fiyat geçmişi biriktikçe
                  (Dashboard → ↻ Fiyatları güncelle) kendiliğinden girer.
                </div>
              )}
              {error && <div className="text-neg">{error}</div>}
              <Link
                to="/gunluk"
                onClick={() => setOpen(false)}
                className="block pt-1 text-accent hover:underline"
              >
                Günlük kâr defteri →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ label, value: raw }: { label: string; value: number }) {
  // Kuruşun altındaki artık "−₺0,00" diye görünmesin
  const value = Math.abs(raw) < 0.005 ? 0 : raw
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className={`num ${value > 0 ? 'text-pos' : value < 0 ? 'text-neg' : 'text-muted'}`}>
        {value > 0 ? '+' : value < 0 ? '−' : ''}
        {formatTRY(Math.abs(value))}
      </span>
    </div>
  )
}
