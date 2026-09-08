/**
 * Halka arz talep toplama son günü ve kapanış saati.
 *
 * halkarz.com tarih alanı serbest metin: "9-10-11 Eylül 2026 09:00-17:00",
 * "12-13-14 Ağustos 2026", "30 Haziran, 1 Temmuz 2026". Son gün, en son
 * geçen ay adından hemen önceki gün listesinin sonuncusudur; kapanış saati
 * metindeki son "ss:dd" ifadesidir (aralığın bitişi). Saat yoksa BIST
 * uygulaması 17:00 varsayılır ve `timeKnown` false döner.
 *
 * Aynı ayrıştırma Edge Function'da (supabase/functions/ipo-deadline) da
 * var — fonksiyonlar kendi kendine yeter tutulduğu için kopya.
 */

const MONTHS: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6,
  temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11,
  aralık: 12, aralik: 12,
}

const MONTH_RE =
  /(ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)/g

export const DEFAULT_CLOSE = '17:00'

export interface IpoDeadline {
  /** Son talep günü, ISO */
  date: string
  /** Kapanış saati "ss:dd" */
  time: string
  /** Saat metinden mi okundu, yoksa 17:00 varsayıldı mı */
  timeKnown: boolean
}

export function parseIpoDeadline(text: string | null | undefined): IpoDeadline | null {
  if (!text) return null
  const lower = text.toLocaleLowerCase('tr')
  const year = lower.match(/\b(20\d{2})\b/)?.[1]
  if (!year) return null

  let last: { day: number; month: number } | null = null
  let m: RegExpExecArray | null
  MONTH_RE.lastIndex = 0
  while ((m = MONTH_RE.exec(lower))) {
    // Ay adından hemen önceki gün dizisi: "9-10-11 " ya da "30 " — araya
    // başka bir ay adı ya da virgülle ayrılmış kelime girince dizi kopar
    const before = lower.slice(0, m.index)
    const tail = before.match(/((?:\b\d{1,2}\b\s*[-–,]?\s*)+)$/)?.[1] ?? ''
    const days = tail.match(/\d{1,2}/g)
    if (days?.length) last = { day: Number(days[days.length - 1]), month: MONTHS[m[1]] }
  }
  if (!last || !(last.day >= 1 && last.day <= 31)) return null

  const times = text.match(/\b\d{1,2}:\d{2}\b/g)
  const raw = times ? times[times.length - 1] : null
  const time = raw ? raw.padStart(5, '0') : DEFAULT_CLOSE

  return {
    date: `${year}-${String(last.month).padStart(2, '0')}-${String(last.day).padStart(2, '0')}`,
    time,
    timeKnown: !!raw,
  }
}

/** Kapanış anı, Türkiye saatiyle (UTC+3) */
export function deadlineAt(d: IpoDeadline): Date {
  return new Date(`${d.date}T${d.time}:00+03:00`)
}

/** "2 gün 4 saat" / "1 saat 20 dk" / "kapandı" */
export function remainingLabel(d: IpoDeadline, now = new Date()): string {
  const ms = deadlineAt(d).getTime() - now.getTime()
  if (ms <= 0) return 'kapandı'
  const min = Math.floor(ms / 60000)
  const days = Math.floor(min / 1440)
  const hours = Math.floor((min % 1440) / 60)
  const mins = min % 60
  if (days > 0) return `${days} gün ${hours} saat`
  if (hours > 0) return `${hours} saat ${mins} dk`
  return `${mins} dk`
}
