import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useTodayReturn } from '../hooks/useTodayReturn'
import { formatNumber, formatPercent, formatTRY } from '../lib/currency'
import { todayISO } from '../lib/calc'

/**
 * Üst çubuktaki "bugünün getirisi" rozeti.
 *
 * Kâr varsa yeşil, zarar varsa kırmızı yanar; tutar rozetin üzerinde yazar.
 * Tıklayınca kırılım açılır: fon/hisse fiyat hareketi, halka arz hisselerinin
 * değişimi, nema geliri ve en çok oynayan kalemler.
 */
/** Kırılımda başta görünen kalem sayısı — gerisi "daha fazla göster" ile açılır */
const MOVERS_SHOWN = 10

export default function TodayReturn() {
  const { user } = useAuth()
  const { total, priceDelta, ipoDelta, nema, ipoLots, priceDate, movers, unmeasured, loading, error, reload } =
    useTodayReturn(user?.id)
  const [open, setOpen] = useState(false)
  const [showAllMovers, setShowAllMovers] = useState(false)

  if (loading) {
    return (
      <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs text-muted border border-border">
        Bugün …
      </span>
    )
  }

  const pos = total > 0.004
  const neg = total < -0.004
  const tone = pos
    ? 'text-pos border-pos/30 bg-pos/10'
    : neg
      ? 'text-neg border-neg/30 bg-neg/10'
      : 'text-muted border-border bg-surface2'
  const sign = pos ? '+' : neg ? '−' : ''
  const stale = priceDate && priceDate !== todayISO()

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border num transition-opacity hover:opacity-80 ${tone}`}
        title="Bugünün getirisi — fon/hisse + halka arz + nema"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="opacity-70 font-medium hidden sm:inline">Bugün</span>
        <span>
          {pos ? '▲' : neg ? '▼' : '•'} {sign}
          {formatTRY(Math.abs(total))}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 z-20 w-72 rounded-lg border border-border bg-surface shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">Bugünün getirisi</span>
              <button
                className="text-xs text-muted hover:text-ink"
                onClick={() => void reload()}
                type="button"
              >
                ↻
              </button>
            </div>

            <div className="px-3 py-2 space-y-1.5 text-xs">
              <Row label="Fon & hisse" value={priceDelta} />
              {(ipoLots > 0 || ipoDelta !== 0) && (
                <Row
                  label={ipoLots > 0 ? `Halka arz (${formatNumber(ipoLots, 0)} lot)` : 'Halka arz'}
                  value={ipoDelta}
                />
              )}
              <Row label="Nema geliri" value={nema} />
              <div className="flex justify-between gap-3 pt-1.5 border-t border-border font-semibold text-ink">
                <span>Toplam</span>
                <span className={`num ${pos ? 'text-pos' : neg ? 'text-neg' : ''}`}>
                  {sign}
                  {formatTRY(Math.abs(total))}
                </span>
              </div>
            </div>

            {movers.length > 0 && (
              <div className="px-3 py-2 border-t border-border space-y-1 max-h-72 overflow-y-auto">
                <div className="text-[11px] uppercase tracking-wide text-muted">En çok oynayan</div>
                {(showAllMovers ? movers : movers.slice(0, MOVERS_SHOWN)).map((m) => (
                  <div key={`${m.source}:${m.symbol}`} className="flex justify-between gap-3 text-xs">
                    <span className="text-ink">
                      {m.symbol}
                      {m.source === 'ipo' && <span className="ml-1 text-muted">arz</span>}
                      {m.firstDay && (
                        <span className="ml-1 text-muted" title="İlk işlem günü — halka arz fiyatına göre">
                          ilk gün
                        </span>
                      )}
                    </span>
                    <span className={`num ${m.delta >= 0 ? 'text-pos' : 'text-neg'}`}>
                      {m.delta >= 0 ? '+' : '−'}
                      {formatTRY(Math.abs(m.delta))}
                      {m.pct !== null && (
                        <span className="text-muted"> ({formatPercent(m.pct)})</span>
                      )}
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
              <div>
                {priceDate ? (
                  <>
                    Fiyatlar: {format(parseISO(priceDate), 'd MMMM yyyy', { locale: tr })}
                    {stale && ' — bugün yeni fiyat gelmedi, son iki fiyat günü karşılaştırıldı.'}
                  </>
                ) : (
                  'Fiyat geçmişi yok; yalnızca nema sayıldı.'
                )}
              </div>
              {unmeasured > 0 && (
                <div>
                  {unmeasured} kalem sayılamadı — önceki gün fiyatı yok. Fiyat geçmişi biriktikçe
                  (Dashboard → ↻ Fiyatları güncelle) kendiliğinden girer.
                </div>
              )}
              {error && <div className="text-neg">{error}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
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
