import type { AssetKind, LedgerRow, TradeWithRefs } from '../types/db'

/**
 * Takas / valör — satış parası hesaba ne zaman geçer.
 *
 * Hisse: T+2 iş günü, saat önemsiz (pazartesi satış → çarşamba).
 * Fon:   valör kadar iş günü (TLY/DFI/THF/DOH 2, TMV 3). Emir 13:00'ten
 *        sonra verildiyse bir gün daha: 13:00 öncesi 2 gün, sonrası 3 gün.
 *        Saat girilmemişse 13:00 öncesi sayılır.
 * Döviz, altın, kripto: aynı gün.
 *
 * İş günü = hafta içi ve resmî tatil değil. Arife yarım günleri iş günü
 * sayılır (Takasbank yarım gün çalışır). Tatil listesi yıllık uzatılır.
 */

/** Fonda valörü bir gün ileri atan emir saati */
export const FUND_CUTOFF = '13:00'

/** Türün varsayılan valörü — kalemde `settle_days` yoksa */
const DEFAULT_DAYS: Record<AssetKind, number> = {
  hisse: 2,
  fon: 2,
  doviz: 0,
  altin: 0,
  mevduat: 0,
  kripto: 0,
  diger: 0,
}

/**
 * BIST / Takasbank kapalı günler. Dinî bayramlar her yıl kayar — yeni yıl
 * girmeden buraya eklenmeli; listede olmayan yıl için yalnız hafta sonu
 * atlanır (tarih 1-2 gün erken görünür, para yine gelir).
 */
export const TR_HOLIDAYS = new Set<string>([
  // 2026
  '2026-01-01',
  '2026-03-20', '2026-03-21', '2026-03-22',                 // Ramazan Bayramı
  '2026-04-23',
  '2026-05-01',
  '2026-05-19',
  '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30',   // Kurban Bayramı
  '2026-07-15',
  '2026-08-30',
  '2026-10-29',
  // 2027
  '2027-01-01',
  '2027-03-09', '2027-03-10', '2027-03-11',                 // Ramazan Bayramı
  '2027-04-23',
  '2027-05-01',
  '2027-05-16', '2027-05-17', '2027-05-18', '2027-05-19',   // Kurban Bayramı (+19 Mayıs)
  '2027-07-15',
  '2027-08-30',
  '2027-10-29',
])

const toISO = (d: Date) => d.toISOString().slice(0, 10)

export function isBusinessDay(iso: string): boolean {
  const dow = new Date(iso + 'T00:00:00Z').getUTCDay()
  return dow !== 0 && dow !== 6 && !TR_HOLIDAYS.has(iso)
}

/** Verilen günden itibaren n iş günü ileri; gün iş günü değilse önce ilk iş gününe çekilir */
export function addBusinessDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  const step = () => d.setUTCDate(d.getUTCDate() + 1)
  while (!isBusinessDay(toISO(d))) step()
  let left = n
  while (left > 0) {
    step()
    if (isBusinessDay(toISO(d))) left--
  }
  return toISO(d)
}

export interface SettleInput {
  tradeDate: string
  /** "ss:dd" ya da null — fonda 13:00 sınırı için */
  tradeTime?: string | null
  kind: AssetKind
  /** Kalemin valörü; null ise türün varsayılanı */
  settleDays?: number | null
}

/** Kaç iş günü sonra — 13:00 sonrası fon emrinde +1 */
export function settleDaysFor(input: SettleInput): number {
  const base = input.settleDays ?? DEFAULT_DAYS[input.kind] ?? 0
  if (base === 0) return 0
  const afterCutoff =
    input.kind === 'fon' &&
    !!input.tradeTime &&
    input.tradeTime.slice(0, 5) >= FUND_CUTOFF &&
    // Hafta sonu / tatil emri ertesi iş günü sabah işlenir; saat sınırı işlemez
    isBusinessDay(input.tradeDate)
  return base + (afterCutoff ? 1 : 0)
}

/** Paranın hesaba geçtiği gün */
export function settlementDate(input: SettleInput): string {
  const n = settleDaysFor(input)
  return n === 0 ? input.tradeDate : addBusinessDays(input.tradeDate, n)
}

/** Formda kullanıcıya gösterilen açıklama: "T+2 · 10 Eyl Perşembe" */
export function settleLabel(input: SettleInput): { days: number; date: string } {
  return { days: settleDaysFor(input), date: settlementDate(input) }
}

// --------------------------------------------------------------------
// Defterde yolda olan para
// --------------------------------------------------------------------

export interface PendingSettlement {
  ledgerId: string
  accountId: string
  amount: number
  /** Satış günü */
  tradeDate: string
  /** Paranın geçeceği gün */
  settleDate: string
  symbol: string
  /** İşlem defteri satışı mı, halka arz satışı mı */
  source: 'trade' | 'ipo'
}

/**
 * `satis` hareketleri deftere işlem günü yazılır ama para o gün gelmez.
 * Takas günü bugünden ileride olan satışlar "yolda" sayılır; bakiye
 * gösterilirken bu kısım düşülür ki hesapta olmayan parayı harcanabilir
 * sanmayasın.
 *
 * Halka arz satışları hisse gibidir: T+2. Elle yazılmış `satis` satırı
 * (işleme ya da arza bağlı değil) zaten hesaba geçmiş para sayılır.
 */
export function pendingSettlements(
  ledger: LedgerRow[],
  trades: TradeWithRefs[],
  today: string
): PendingSettlement[] {
  const tradeById = new Map(trades.map((t) => [t.id, t]))
  const out: PendingSettlement[] = []
  for (const l of ledger) {
    if (l.kind !== 'satis' || Number(l.amount) <= 0) continue
    let settleDate: string
    let symbol: string
    let source: PendingSettlement['source']
    if (l.trade_id) {
      const t = tradeById.get(l.trade_id)
      if (!t) continue
      settleDate = settlementDate({
        tradeDate: t.trade_date,
        tradeTime: t.trade_time,
        kind: t.assets?.kind ?? 'hisse',
        settleDays: t.assets?.settle_days,
      })
      symbol = t.assets?.symbol ?? '—'
      source = 'trade'
    } else if (l.ipo_id) {
      settleDate = settlementDate({ tradeDate: l.date, kind: 'hisse' })
      symbol = l.note?.split(' — ')[0]?.trim() || 'arz'
      source = 'ipo'
    } else {
      continue
    }
    if (settleDate <= today) continue
    out.push({
      ledgerId: l.id,
      accountId: l.account_id,
      amount: Number(l.amount),
      tradeDate: l.date,
      settleDate,
      symbol,
      source,
    })
  }
  return out.sort((a, b) => a.settleDate.localeCompare(b.settleDate))
}

/** Hesap bazında yolda olan toplam ve en erken geliş günü */
export function pendingByAccount(list: PendingSettlement[]): Map<string, { amount: number; next: string }> {
  const m = new Map<string, { amount: number; next: string }>()
  for (const p of list) {
    const cur = m.get(p.accountId)
    if (!cur) m.set(p.accountId, { amount: p.amount, next: p.settleDate })
    else {
      cur.amount += p.amount
      if (p.settleDate < cur.next) cur.next = p.settleDate
    }
  }
  return m
}
