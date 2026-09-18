import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { usePortfolio } from '../hooks/usePortfolio'
import { Badge, Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatTRY } from '../lib/currency'
import type { Holding } from '../lib/holdings'

/**
 * Para Gitti Baby — kaybolan fonların anıt sayfası ve "elde gerçekten ne
 * var" sorusunun cevabı.
 *
 * Dört fon (THF · TLY · DOH · DFI) elde ne kadar varsa oradan okunur, ama
 * kağıt üstündeki değerine inanmıyoruz: hepsi **%10 tıraşlı** sayılır. Bu
 * bir vergi, komisyon ya da valör hesabı değil — "bu para bu haliyle gelmez"
 * diyen bir gerçeklik kesintisi.
 *
 * Nakit ve hisseler tıraşsız: aracı kurumda, elde. Ana paraya olduğu gibi
 * girerler — Dashboard'la aynı kaynaktan (usePortfolio) okunur ki iki sayfa
 * farklı rakam göstermesin.
 *
 * TMV ve tasfiyedeki pozisyonlar ayrı vaka: ne kadar döneceği belli değil.
 * Kendiliğinden ana paraya girmezler; her kutuda ses açar gibi bir sürgü var,
 * kaç yüzdesinin döneceğini sen söylersin, "ekle" deyince o tutar ana paraya
 * girer. Yalnızca sayfa hafızasında — veritabanına yazılmaz, sayfadan çıkıp
 * girince sıfırlanır. Tahmin bu, kayıt değil.
 *
 * Sayfanın tonu şakadır, sayıları değil: tıraş ve sürgü dışındaki her rakam
 * defterdeki gerçek veriden gelir.
 */

/** Gerçeklik kesintisi — "gelirse bu kadar gelir" */
const HAIRCUT = 0.1

/** Anıtın sahipleri */
const GONE = ['THF', 'TLY', 'DOH', 'DFI'] as const

/** Parasının nerede olduğu bilinmeyen fon */
const MISSING = 'TMV'

/** Beklemeye başladığımız gün — sayaç buradan sayar */
const WAITING_SINCE = '2026-08-19'

interface LiquidationRule {
  symbol: string
  /** Boşsa sembolün elde kalan tamamı tasfiyede sayılır */
  quantity?: number
}

/**
 * Tasfiyede bekleyen pozisyonlar — kullanıcıya göre (profiles.id).
 *
 * Emre'de TLY'nin 2 adedi, Alper'de DOH'un tamamı tasfiyede. Bunlar anıt
 * listesinden düşülür ve kendi kutusunda durur; ana paraya yalnız sürgüyle
 * eklenen kadarı girer. Elde tanımlı adetten az varsa eldeki kadarı sayılır.
 */
const LIQUIDATION: Record<string, LiquidationRule[]> = {
  // alperbuber800
  '257baf6f-3d32-4448-a5bb-107e1202e8da': [{ symbol: 'DOH' }],
  // emregeriz
  '54a6d9b2-5ee5-47da-953c-6c122706baa4': [{ symbol: 'TLY', quantity: 2 }],
}

const EXCUSES = [
  'Operasyon ekibi bakıyor.',
  'Yarın sabah ilk iş hallolacak.',
  'Sistemsel bir yoğunluk var, biliyorsunuz.',
  'Valör günü kaydı, pazartesiye sarkabilir.',
  'Mutabakat bekliyoruz, sizden kaynaklı değil.',
  'Şu an yetkili arkadaş izinde.',
  'Bankadan dönüş bekliyoruz.',
  'Talebiniz sıraya alındı, teşekkürler.',
  'Küçük bir teknik aksaklık, geçer.',
  'Bir daha deneyelim, bazen oluyor.',
]

const STAGES = [
  { label: 'İnkâr', note: 'Gelir canım, panik yok.' },
  { label: 'Öfke', note: 'Bir arayın şunları.' },
  { label: 'Pazarlık', note: 'Yarısı gelse razıyım.' },
  { label: 'Depresyon', note: 'Bu sayfayı niye açtım.' },
  { label: 'Kabulleniş', note: 'Para gitti baby.' },
]

const fmtQty = (n: number) => formatNumber(n, 6)

/** Fiyatı olmayan kalem maliyetiyle sayılır — Dashboard da böyle yapıyor */
const unitValue = (h: Holding) => h.price ?? h.avgCost

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0)

const daysSince = (iso: string) =>
  Math.max(0, Math.floor((Date.now() - new Date(`${iso}T00:00:00`).getTime()) / 86400000))

/** Saniyede bir tazelenen "ne kadar oldu" sayacı */
function useElapsed(sinceISO: string) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const ms = Math.max(0, now - new Date(`${sinceISO}T00:00:00`).getTime())
  const s = Math.floor(ms / 1000)
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  }
}

/** Dönüşümlü bahane — hiçbiri tutmuyor ama akış hoş */
function useExcuse() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI((v) => (v + 1) % EXCUSES.length), 4000)
    return () => clearInterval(id)
  }, [])
  return { text: EXCUSES[i], no: i + 1 }
}

function Digit({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center">
      <div className="text-2xl sm:text-3xl font-semibold num text-ink">
        {String(value).padStart(2, '0')}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted mt-0.5">{label}</div>
    </div>
  )
}

/**
 * Ses açar gibi: sürgü kaç yüzdesinin döneceğini söyler, "ekle" deyince o
 * tutar ana paraya girer. Sürgüyü sonradan oynatmak eklenen tutarı
 * değiştirmez — "güncelle" demen gerekir; böylece deneme ile karar ayrı durur.
 * Hiçbir şey veritabanına yazılmaz; sayfadan çıkınca sıfırlanır.
 */
function RecoveryDial({
  paper,
  added,
  onAdd,
  onClear,
}: {
  /** Kağıt üstündeki tutar — sürgü bunun yüzdesini alır */
  paper: number
  /** Ana paraya eklenmiş tutar; 0 ise eklenmemiş */
  added: number
  onAdd: (amount: number) => void
  onClear: () => void
}) {
  const [pct, setPct] = useState(0)
  const amount = Math.round(paper * pct) / 100
  const unchanged = added > 0 && Math.abs(added - amount) < 0.005

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted uppercase tracking-wide">
          Ne kadarı döner?
        </span>
        <span className="text-sm num">
          <strong className="text-ink">%{pct}</strong>
          <span className="text-muted"> döner · %{100 - pct} kayıp</span>
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span aria-hidden>🔇</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          className="flex-1 h-2 p-0 bg-transparent border-0 rounded-none focus:ring-0 accent-accent cursor-pointer"
          aria-label="Geri dönüş yüzdesi"
        />
        <span aria-hidden>🔊</span>
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-lg font-semibold num text-ink">{formatTRY(amount)}</div>
          <div className="text-[11px] text-muted">
            {added > 0 ? (
              <>
                Ana parada <strong className="num text-accent">{formatTRY(added)}</strong>
              </>
            ) : (
              'Ana parada henüz yok'
            )}
          </div>
        </div>
        <div className="flex gap-1.5">
          {added > 0 && (
            <button type="button" className="btn-ghost text-xs" onClick={onClear}>
              Çıkar
            </button>
          )}
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={amount <= 0 || unchanged}
            onClick={() => onAdd(amount)}
          >
            {added > 0 ? 'Güncelle' : 'Ana paraya ekle'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ParaGitti() {
  const { user } = useAuth()
  const scope = user?.id ?? ''
  const p = usePortfolio(scope)
  const excuse = useExcuse()
  const elapsed = useElapsed(WAITING_SINCE)
  const [stage, setStage] = useState(0)
  /** Sürgüyle ana paraya eklenen tahminler — yalnız sayfa hafızasında */
  const [tmvAdded, setTmvAdded] = useState(0)
  const [liqAdded, setLiqAdded] = useState(0)

  /** Sembol → elde kalan pozisyon (arz dağıtımları dahil, Dashboard'la aynı) */
  const held = useMemo(
    () => new Map(p.holdings.filter((h) => h.quantity > 0).map((h) => [h.symbol, h])),
    [p.holdings]
  )

  /** Tasfiyedeki pozisyonlar — bu kullanıcı için tanımlı olup elde bulunanlar */
  const liquidation = useMemo(
    () =>
      (LIQUIDATION[scope] ?? []).flatMap((rule) => {
        const h = held.get(rule.symbol)
        if (!h) return []
        const quantity = Math.min(h.quantity, rule.quantity ?? h.quantity)
        if (!(quantity > 0)) return []
        return [
          {
            symbol: rule.symbol,
            name: h.name,
            quantity,
            price: h.price,
            gross: quantity * unitValue(h),
          },
        ]
      }),
    [held, scope]
  )
  const liqGross = sum(liquidation, (l) => l.gross)

  /** Dört fonun elde kalanı — tasfiyedeki adet düşülmüş; sıra GONE ile sabit */
  const rows = useMemo(
    () =>
      GONE.map((symbol) => {
        const h = held.get(symbol)
        const inLiq = liquidation.find((l) => l.symbol === symbol)?.quantity ?? 0
        const quantity = h ? Math.max(0, h.quantity - inLiq) : 0
        const gross = h ? quantity * unitValue(h) : 0
        return {
          symbol,
          name: h?.name ?? null,
          quantity,
          price: h?.price ?? null,
          costBasis: h ? quantity * h.avgCost : 0,
          /** Kağıt üstündeki değer */
          gross,
          /** Tıraştan sonra kalan — "gelirse bu kadar gelir" */
          net: gross * (1 - HAIRCUT),
          found: quantity > 0,
          /** Bu sembolden tasfiyede bekleyen adet — listeden düşüldü */
          inLiquidation: inLiq,
        }
      }),
    [held, liquidation]
  )
  const present = rows.filter((r) => r.found)
  const fundsGross = sum(rows, (r) => r.gross)
  const fundsNet = fundsGross * (1 - HAIRCUT)
  const haircut = fundsGross - fundsNet
  const costTotal = sum(rows, (r) => r.costBasis)

  /** TMV — pozisyon defterde, parası ortada yok; kağıt üstündeki tutar gösterilir */
  const tmv = held.get(MISSING) ?? null
  const tmvGross = tmv ? tmv.quantity * unitValue(tmv) : 0

  /** Hisseler — aracı kurumda, tıraşsız; arz dağıtımları da burada */
  const stocks = useMemo(
    () =>
      p.holdings
        .filter((h) => h.kind === 'hisse' && h.quantity > 0)
        .map((h) => ({ symbol: h.symbol, quantity: h.quantity, value: h.value ?? h.costBasis }))
        .sort((a, b) => b.value - a.value),
    [p.holdings]
  )
  const stockTotal = sum(stocks, (s) => s.value)

  /** Nakit — kendi hesaplar + arz hesapları + arzda bloke; Dashboard'la aynı toplam */
  const cash = p.cashTotal
  const cashLines = [
    { label: 'Kendi hesaplar', value: p.cashTotals.cash },
    { label: 'Arz hesapları', value: p.totalWaiting },
    { label: 'Arzda bloke', value: p.blockedTotal },
  ].filter((l) => l.value > 0)

  /** Her şey ekranda yazdığı gibi */
  const paper = fundsGross + tmvGross + liqGross + cash + stockTotal
  /** Ana para: tıraşlı fon + nakit + hisse + sürgüyle eklenenler */
  const principal = fundsNet + cash + stockTotal + tmvAdded + liqAdded
  const gap = paper - principal
  const tmvGap = tmvGross - tmvAdded
  const liqGap = liqGross - liqAdded

  if (p.loading) return <Spinner label="Para aranıyor…" />

  return (
    <>
      <PageHeader
        title="Para Gitti Baby"
        subtitle={
          <>
            THF · TLY · DOH · DFI <strong>%10 tıraşlı</strong>. Nakit ve hisse tıraşsız.
            {' '}{MISSING} ve tasfiye: sen ne kadar döner dersen o kadar.
          </>
        }
        actions={
          <span className="text-xs text-muted">
            {p.latestDate ? `Fiyatlar: ${p.latestDate}` : 'Fiyat yok'}
          </span>
        }
      />

      {p.error && <ErrorBox message={p.error} />}
      {p.priceError && <ErrorBox message={p.priceError} />}

      {/* Üst şerit — sayfanın tek cümlelik özeti */}
      <div className="rounded-xl border border-neg/40 bg-neg/10 px-4 py-3 mb-5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-lg">🚨</span>
        <span className="text-sm font-medium text-neg">
          Dolandırıldık. Bu sayfa o yüzden var.
        </span>
        <span className="text-xs text-muted">
          Bahane #{excuse.no}: “{excuse.text}”
        </span>
      </div>

      {/* Üç sayı: hayal, gerçek, aradaki fark — hepsi aynı kapsam */}
      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <div className="card">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">
            Kağıt üstünde
          </div>
          <div className="mt-2 text-2xl font-semibold num text-muted line-through decoration-neg/70 decoration-2">
            {formatTRY(paper)}
          </div>
          <div className="mt-1 text-xs text-muted">
            Fon + {MISSING} + tasfiye + nakit + hisse, ekranda yazdığı gibi
          </div>
        </div>

        <div className="card border-neg/40">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">
            Ana para — gelirse bu kadar gelir
          </div>
          <div className="mt-2 text-2xl font-semibold num text-neg">{formatTRY(principal)}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>Fon %{HAIRCUT * 100} tıraşlı · {formatTRY(fundsNet)}</Badge>
            <Badge>Nakit · {formatTRY(cash)}</Badge>
            <Badge>Hisse · {formatTRY(stockTotal)}</Badge>
            {tmvAdded > 0 && <Badge tone="accent">{MISSING} tahmini · +{formatTRY(tmvAdded)}</Badge>}
            {liqAdded > 0 && <Badge tone="accent">Tasfiye tahmini · +{formatTRY(liqAdded)}</Badge>}
          </div>
        </div>

        <div className="card">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">
            Aradaki fark
          </div>
          <div className="mt-2 text-2xl font-semibold num text-amber-600 dark:text-amber-400">
            −{formatTRY(gap)}
          </div>
          <div className="mt-1 text-xs text-muted">
            Tıraş −{formatTRY(haircut)}
            {tmvGap > 0 && <> · {MISSING} −{formatTRY(tmvGap)}</>}
            {liqGap > 0 && <> · tasfiye −{formatTRY(liqGap)}</>}
            . Kimsenin açıklayamadığı kısım; vergi değil, komisyon değil, “o kadar işte”.
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Anıt Listesi" className="lg:col-span-2">
          {present.length === 0 ? (
            <Empty>
              Bu dört fondan defterde açık pozisyon kalmamış. Ya hepsi gitti ya da hiç
              yoktu — ikisi de aynı kapıya çıkıyor.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Fon</th>
                    <th className="th text-right">Adet</th>
                    <th className="th text-right">Fiyat</th>
                    <th className="th text-right">Kağıt üstünde</th>
                    <th className="th text-right">%{HAIRCUT * 100} tıraşlı</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.symbol} className={r.found ? '' : 'opacity-50'}>
                      <td className="td">
                        <div className="font-medium">{r.symbol}</div>
                        <div className="text-xs text-muted">
                          {r.found
                            ? (r.name ?? '—')
                            : r.inLiquidation > 0
                              ? 'Tamamı tasfiyede — aşağıdaki kutuda'
                              : 'Defterde açık pozisyon yok'}
                          {r.found && r.inLiquidation > 0 && (
                            <> · {fmtQty(r.inLiquidation)} adedi tasfiyede</>
                          )}
                        </div>
                      </td>
                      <td className="td text-right num">{r.found ? fmtQty(r.quantity) : '—'}</td>
                      <td className="td text-right num">
                        {r.price != null ? formatNumber(r.price, 6) : '—'}
                      </td>
                      <td className="td text-right num text-muted line-through decoration-neg/60">
                        {r.found ? formatTRY(r.gross) : '—'}
                      </td>
                      <td className="td text-right num text-neg font-medium">
                        {r.found ? formatTRY(r.net) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border">
                    <td className="td font-semibold">Toplam</td>
                    <td className="td" />
                    <td className="td" />
                    <td className="td text-right num text-muted line-through decoration-neg/60">
                      {formatTRY(fundsGross)}
                    </td>
                    <td className="td text-right num text-neg font-semibold">
                      {formatTRY(fundsNet)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {costTotal > 0 && (
            <p className="mt-3 text-xs text-muted">
              Bu kağıtlara girerken {formatTRY(costTotal)} verilmişti. Tıraşlı hâliyle elde
              kalan {formatTRY(fundsNet)}. Aradaki farkı kimseye sormayın — cevap yukarıdaki
              bahane listesinden geliyor.
            </p>
          )}
        </Card>

        <Card title="Elde olanlar — tıraşsız">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">Nakit</div>
          <div className="mt-1 text-xl font-semibold num text-ink">{formatTRY(cash)}</div>
          {cashLines.length > 0 ? (
            <dl className="mt-1 space-y-0.5 text-xs">
              {cashLines.map((l) => (
                <div key={l.label} className="flex justify-between gap-2">
                  <dt className="text-muted">{l.label}</dt>
                  <dd className="num text-ink">{formatTRY(l.value)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-1 text-xs text-muted">Hesaplarda para yok.</p>
          )}

          <div className="mt-4 text-xs font-medium text-muted uppercase tracking-wide">Hisse</div>
          <div className="mt-1 text-xl font-semibold num text-ink">{formatTRY(stockTotal)}</div>
          {stocks.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs">
              {stocks.map((s) => (
                <li key={s.symbol} className="flex justify-between gap-2">
                  <span className="text-ink">
                    {s.symbol} <span className="text-muted">× {fmtQty(s.quantity)}</span>
                  </span>
                  <span className="num text-muted">{formatTRY(s.value)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">Defterde hisse yok.</p>
          )}

          <p className="mt-3 text-xs text-muted">
            Bunlar aracı kurumda, elde. Tıraş yok, tahmin yok — ana paraya olduğu gibi girer.
            Dashboard'la aynı rakam.
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mt-4">
        <Card title={`${MISSING} — Kayıp İlanı`}>
          <div className="rounded-lg border border-dashed border-border bg-surface2 p-4 text-center">
            <div className="text-4xl mb-2">🕵️</div>
            <div className="text-sm font-medium text-ink">{MISSING} parası</div>
            <div className="mt-1 text-3xl font-semibold num text-muted line-through decoration-neg/60">
              {tmv ? formatTRY(tmvGross) : '?'}
            </div>
            <div className="mt-1 text-xs text-muted">
              {tmv
                ? `Kağıt üstünde · ${fmtQty(tmv.quantity)} adet${
                    tmv.price != null ? ` × ${formatNumber(tmv.price, 6)}` : ' (maliyetten)'
                  }`
                : 'Defterde pozisyon yok'}
            </div>
          </div>

          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Nerede?</dt>
              <dd className="text-ink text-right">Belli değil</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Ne zaman gelir?</dt>
              <dd className="text-ink text-right">Belli değil</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Kim biliyor?</dt>
              <dd className="text-ink text-right">Hiç kimse</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Girerken verilen</dt>
              <dd className="text-ink text-right num">{tmv ? formatTRY(tmv.costBasis) : '—'}</dd>
            </div>
          </dl>

          {tmv && (
            <RecoveryDial
              paper={tmvGross}
              added={tmvAdded}
              onAdd={setTmvAdded}
              onClear={() => setTmvAdded(0)}
            />
          )}

          <p className="mt-3 text-xs text-muted">
            Pozisyon defterde durabilir; parası ortada yok. Ana paraya kendiliğinden girmez —
            sürgüyle ne kadar döner dersen o kadar girer.
          </p>
        </Card>

        <Card title="Tasfiye — kapıda bekleyenler">
          {liquidation.length === 0 ? (
            <Empty>Tasfiyede bir şey yok. Şimdilik.</Empty>
          ) : (
            <>
              <div className="rounded-lg border border-dashed border-border bg-surface2 p-4 text-center">
                <div className="text-4xl mb-2">🧹</div>
                <div className="text-sm font-medium text-ink">
                  {liquidation.map((l) => `${fmtQty(l.quantity)} ${l.symbol}`).join(' · ')}
                </div>
                <div className="mt-1 text-3xl font-semibold num text-muted line-through decoration-neg/60">
                  {formatTRY(liqGross)}
                </div>
                <div className="mt-1 text-xs text-muted">Kağıt üstünde · anıt listesinden düşüldü</div>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">Fon</th>
                      <th className="th text-right">Adet</th>
                      <th className="th text-right">Fiyat</th>
                      <th className="th text-right">Kağıt üstünde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liquidation.map((l) => (
                      <tr key={l.symbol}>
                        <td className="td">
                          <div className="font-medium">{l.symbol}</div>
                          <div className="text-xs text-muted">{l.name ?? '—'}</div>
                        </td>
                        <td className="td text-right num">{fmtQty(l.quantity)}</td>
                        <td className="td text-right num">
                          {l.price != null ? formatNumber(l.price, 6) : '—'}
                        </td>
                        <td className="td text-right num text-muted line-through decoration-neg/60">
                          {formatTRY(l.gross)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <RecoveryDial
                paper={liqGross}
                added={liqAdded}
                onAdd={setLiqAdded}
                onClear={() => setLiqAdded(0)}
              />

              <p className="mt-3 text-xs text-muted">
                Tasfiye bitince ne kadar dönecek, kimse söylemiyor. Biz bir rakam tutup
                ekliyoruz; tutmazsa sürgüyü kaydırırız.
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mt-4">
        <Card title="Bekleme Sayacı">
          <div className="grid grid-cols-4 gap-2">
            <Digit value={elapsed.days} label="gün" />
            <Digit value={elapsed.hours} label="saat" />
            <Digit value={elapsed.minutes} label="dk" />
            <Digit value={elapsed.seconds} label="sn" />
          </div>
          <p className="mt-3 text-xs text-muted text-center">
            {WAITING_SINCE} tarihinden beri bekliyoruz, {daysSince(WAITING_SINCE)} gün oldu.
            Sayaç <strong>ileri</strong> sayıyor — geri sayabilmek için bir tarih lazım,
            elimizde o yok.
          </p>
        </Card>

        <Card title="Yas Aşamaları">
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setStage(i)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  i === stage
                    ? 'bg-neg/15 text-neg border-neg/40'
                    : 'text-muted border-border hover:text-ink'
                }`}
              >
                {i + 1}. {s.label}
              </button>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-surface2 border border-border p-4">
            <div className="text-sm font-medium text-ink">{STAGES[stage].label}</div>
            <div className="mt-1 text-sm text-muted">{STAGES[stage].note}</div>
          </div>
          <p className="mt-3 text-xs text-muted">
            Beşinci aşamaya gelmen tıraşı geri getirmiyor. Ama artık biliyorsun.
          </p>
        </Card>
      </div>

      <p className="mt-5 text-center text-xs text-muted">
        Adet, fiyat, nakit ve hisse defterden gerçek okunur; tek uydurma şey iyimserlik — bir de
        sürgü. Sürgüdeki tahmin veritabanına yazılmaz, sayfadan çıkınca sıfırlanır.
      </p>
    </>
  )
}
