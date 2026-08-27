import { supabase } from './supabase'
import { todayISO } from './calc'
import { planNema, type CashMove } from './nema'
import type { LedgerKind } from '../types/db'

export const LEDGER_LABELS: Record<LedgerKind, string> = {
  giris: 'Para girişi',
  cikis: 'Para çıkışı',
  transfer: 'Aktarım',
  nema: 'Nema',
  iade: 'Arz iadesi',
  satis: 'Satış geliri',
  cekim: 'Çekim',
  borc: 'Borç verme',
  tahsil: 'Borç tahsilatı',
  alim: 'Hisse/fon alışı',
  temettu: 'Temettü',
  talep: 'Arz talebi (bloke)',
  diger: 'Diğer',
}

export const LEDGER_TONES: Record<LedgerKind, string> = {
  giris: 'pos',
  cikis: 'neg',
  transfer: 'muted',
  nema: 'accent',
  iade: 'accent',
  satis: 'pos',
  cekim: 'neg',
  borc: 'warn',
  tahsil: 'pos',
  alim: 'neg',
  temettu: 'pos',
  // Para kaybolmadı, dağıtıma kadar aracı kurumda bekliyor — bu yüzden
  // "çıkış" kırmızısı değil, beklemeyi anlatan uyarı tonu.
  talep: 'warn',
  diger: 'muted',
}

// --------------------------------------------------------------------
// Faizi veritabanına işleme
// --------------------------------------------------------------------

interface AccountNema {
  id: string
  nema_rate: number | null
  nema_start: string | null
}

/** Aynı oturumda aynı gün için ikinci kez çalışmasın diye */
const running = new Map<string, Promise<number>>()

/**
 * Nemalandırma tanımlı hesaplara, eksik kalan günlerin faizini yazar.
 *
 * Tarayıcıdan çalışır: uygulama her açıldığında son işlenen günden bugüne
 * kadar olan faiz tamamlanır. Uygulamayı bir hafta açmazsan, açtığında
 * yedi günün faizi ayrı satırlar hâlinde işlenir.
 *
 * Aynı kullanıcı + aynı gün için tek sefer çalışır; kısmi çakışmayı
 * (iki sekme) veritabanındaki tekil indeks yakalar.
 */
export async function runNemaAccrual(
  userId: string,
  today = todayISO(),
  /** Oran değiştiyse aynı gün içinde yeniden çalıştırmak için */
  force = false
): Promise<number> {
  const key = `${userId}:${today}`
  if (force) running.delete(key)
  const existing = running.get(key)
  if (existing) return existing

  const job = (async () => {
    const { data: accs } = await supabase
      .from('accounts')
      .select('id, nema_rate, nema_start')
      .eq('user_id', userId)
      .gt('nema_rate', 0)

    const accounts = (accs ?? []) as AccountNema[]
    if (!accounts.length) return 0

    const ids = accounts.map((a) => a.id)
    const { data: moves } = await supabase
      .from('account_ledger')
      .select('account_id, date, amount, kind')
      .in('account_id', ids)

    const byAccount = new Map<string, CashMove[]>()
    for (const m of (moves ?? []) as (CashMove & { account_id: string })[]) {
      const list = byAccount.get(m.account_id)
      if (list) list.push(m)
      else byAccount.set(m.account_id, [m])
    }

    const rows: Record<string, unknown>[] = []
    for (const a of accounts) {
      const days = planNema({
        moves: byAccount.get(a.id) ?? [],
        annualPct: Number(a.nema_rate ?? 0),
        today,
        startFrom: a.nema_start,
      })
      for (const d of days) {
        rows.push({
          user_id: userId,
          account_id: a.id,
          kind: 'nema',
          amount: d.amount,
          date: d.date,
          note: `Nemalandırma · %${Number(a.nema_rate).toString().replace('.', ',')} yıllık`,
        })
      }
    }
    if (!rows.length) return 0

    const { error } = await supabase.from('account_ledger').insert(rows)
    if (!error) return rows.length

    // Tekil indeks çarptıysa (başka sekme aynı günü işlemiş) satır satır dene
    if (error.code !== '23505') throw new Error(error.message)
    let written = 0
    for (const r of rows) {
      const res = await supabase.from('account_ledger').insert(r)
      if (!res.error) written++
      else if (res.error.code !== '23505') throw new Error(res.error.message)
    }
    return written
  })()

  running.set(key, job)
  try {
    return await job
  } catch (e) {
    running.delete(key) // hata geçiciyse bir sonraki denemede tekrar çalışsın
    throw e
  }
}
