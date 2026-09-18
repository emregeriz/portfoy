import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useTrades } from '../hooks/useTrades'
import { usePrices } from '../hooks/usePrices'
import { useCorporate } from '../hooks/useCorporate'
import { Card, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatNumber, formatTRY } from '../lib/currency'
import { computeHoldings } from '../lib/holdings'

/**
 * Para Gitti Baby — kaybolan fonların anıt sayfası.
 *
 * Dört fon (THF · TLY · DOH · DFI) elde ne kadar varsa oradan okunur, ama
 * kağıt üstündeki değerine inanmıyoruz: hepsi **%10 tıraşlı** gösterilir.
 * Bu bir vergi, komisyon ya da valör hesabı değil — "bu para bu haliyle
 * gelmez" diyen bir gerçeklik kesintisi. Tıraşsız hali de yanında durur ki
 * hayalle gerçek arasındaki fark görünsün.
 *
 * TMV ayrı bir vaka: nerede olduğu belli değil. Pozisyonu toplamaya
 * katmıyoruz, çünkü katacak bir rakam yok — sayfada bilerek "?" ile duruyor.
 * Geliş tarihi de yok; sayaç bu yüzden geriye değil, ileriye — beklemeye
 * başladığımız günden bu yana — sayıyor.
 *
 * Sayfanın tonu şakadır, sayıları değil: tıraş dışındaki her rakam
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

export default function ParaGitti() {
  const { user } = useAuth()
  const scope = user?.id ?? null
  const { rows: trades, loading, error } = useTrades(scope)
  const { bySymbol, latestDate } = usePrices()
  const corporate = useCorporate(scope)
  const excuse = useExcuse()
  const elapsed = useElapsed(WAITING_SINCE)
  const [stage, setStage] = useState(0)

  const holdings = useMemo(
    () =>
      computeHoldings(trades, bySymbol, {
        actions: corporate.actions,
        dividends: corporate.dividends,
      }),
    [trades, bySymbol, corporate.actions, corporate.dividends]
  )

  /** Dört fonun elde kalan pozisyonu — sıra GONE ile sabit, bulunamayan da satır alır */
  const rows = useMemo(
    () =>
      GONE.map((symbol) => {
        const h = holdings.find((x) => x.symbol === symbol && x.quantity > 0)
        // Fiyatı olmayan kalem maliyetiyle sayılır — Dashboard da böyle yapıyor
        const gross = h ? (h.value ?? h.costBasis) : 0
        return {
          symbol,
          name: h?.name ?? null,
          quantity: h?.quantity ?? 0,
          price: h?.price ?? null,
          costBasis: h?.costBasis ?? 0,
          /** Kağıt üstündeki değer */
          gross,
          /** Tıraştan sonra kalan — "gelirse bu kadar gelir" */
          net: gross * (1 - HAIRCUT),
          found: !!h,
        }
      }),
    [holdings]
  )

  const grossTotal = rows.reduce((s, r) => s + r.gross, 0)
  const netTotal = grossTotal * (1 - HAIRCUT)
  const haircut = grossTotal - netTotal
  const costTotal = rows.reduce((s, r) => s + r.costBasis, 0)
  const present = rows.filter((r) => r.found)

  /** TMV — pozisyon defterde olabilir, parası ortada yok */
  const tmv = holdings.find((h) => h.symbol === MISSING)

  if (loading) return <Spinner label="Para aranıyor…" />

  return (
    <>
      <PageHeader
        title="Para Gitti Baby"
        subtitle={
          <>
            THF · TLY · DOH · DFI — elde ne varsa <strong>%10 tıraşlı</strong> yazılı.
            {' '}{MISSING} nerede, bilen yok. Tarih de yok.
          </>
        }
        actions={
          <span className="text-xs text-muted">
            {latestDate ? `Fiyatlar: ${latestDate}` : 'Fiyat yok'}
          </span>
        }
      />

      {error && <ErrorBox message={error} />}

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

      {/* Üç sayı: hayal, gerçek, aradaki fark */}
      <div className="grid gap-4 sm:grid-cols-3 mb-5">
        <div className="card">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">
            Kağıt üstünde
          </div>
          <div className="mt-2 text-2xl font-semibold num text-muted line-through decoration-neg/70 decoration-2">
            {formatTRY(grossTotal)}
          </div>
          <div className="mt-1 text-xs text-muted">Ekranda yazan, inanmadığımız rakam</div>
        </div>

        <div className="card border-neg/40">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">
            Gelirse bu kadar gelir
          </div>
          <div className="mt-2 text-2xl font-semibold num text-neg">{formatTRY(netTotal)}</div>
          <div className="mt-1 text-xs text-muted">
            %{HAIRCUT * 100} tıraşlı · {present.length}/{GONE.length} fon defterde bulundu
          </div>
        </div>

        <div className="card">
          <div className="text-xs font-medium text-muted uppercase tracking-wide">Tıraş payı</div>
          <div className="mt-2 text-2xl font-semibold num text-amber-600 dark:text-amber-400">
            −{formatTRY(haircut)}
          </div>
          <div className="mt-1 text-xs text-muted">
            Kimsenin açıklayamadığı kayıp. Vergi değil, komisyon değil, “o kadar işte”.
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
                          {r.found ? (r.name ?? '—') : 'Defterde açık pozisyon yok'}
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
                      {formatTRY(grossTotal)}
                    </td>
                    <td className="td text-right num text-neg font-semibold">
                      {formatTRY(netTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {costTotal > 0 && (
            <p className="mt-3 text-xs text-muted">
              Bu kağıtlara girerken {formatTRY(costTotal)} verilmişti. Tıraşlı hâliyle elde
              kalan {formatTRY(netTotal)}. Aradaki farkı kimseye sormayın — cevap yukarıdaki
              bahane listesinden geliyor.
            </p>
          )}
        </Card>

        <Card title={`${MISSING} — Kayıp İlanı`}>
          <div className="rounded-lg border border-dashed border-border bg-surface2 p-4 text-center">
            <div className="text-4xl mb-2">🕵️</div>
            <div className="text-sm font-medium text-ink">{MISSING} parası</div>
            <div className="mt-1 text-3xl font-semibold num text-muted">?</div>
            <div className="mt-1 text-xs text-muted">Tutar bilinmiyor</div>
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
              <dt className="text-muted">Defterdeki pozisyon</dt>
              <dd className="text-ink text-right num">
                {tmv && tmv.quantity > 0 ? `${fmtQty(tmv.quantity)} adet` : 'Yok'}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-xs text-muted">
            Pozisyon defterde durabilir; parası ortada yok. Bu yüzden yukarıdaki toplama
            katılmadı — katılacak bir rakam olsa zaten bu kart olmazdı.
          </p>
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
        Bu sayfadaki adet ve fiyatlar defterden gerçek okunur; tek uydurma şey iyimserlik.
      </p>
    </>
  )
}
