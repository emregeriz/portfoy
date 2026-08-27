import type { IpoEntry, IpoRow, LedgerRow } from '../types/db'

/**
 * Talep karşılığı — "arza girdiğim parayı nereden verdim" sorusunun cevabı.
 *
 * Arza talep verirken hesaptan bir tutar bloke edilir. Defter bugüne kadar
 * yalnızca dönüşü ("iade") tutuyordu; bloke tarafı hiç yazılmadığı için
 * hesapta zaten duran parayla arza girdiğinde iade yeni para gibi görünüyor
 * ve bakiye şişiyordu. Artık her talep için bir `talep` satırı (−) yazılır:
 *
 *     talep (−)  istenen lot × lot fiyatı
 *     iade  (+)  (istenen − düşen) × lot fiyatı
 *     ─────────────────────────────────────
 *     net   (−)  düşen lot × lot fiyatı   = elindeki payın maliyeti
 *
 * Hesapta yeterli para yoksa aradaki fark bir yerden gelmek zorunda; onu da
 * kullanıcı söyler:
 *
 *   mevcut → hesapta zaten duruyordu, ek kayıt yok
 *   aktar  → kendi hesabından attın, transfer çifti yazılır (toplam değişmez)
 *   disari → sisteme yeni para girdi, `giris` yazılır (toplam artar)
 */

export type FundingSource = 'mevcut' | 'aktar' | 'disari'

export const FUNDING_LABELS: Record<FundingSource, string> = {
  mevcut: 'Hesaptaki parayla',
  aktar: 'Kendi hesabımdan attım',
  disari: 'Dışarıdan yatırdım',
}

export interface FundingChoice {
  source: FundingSource
  /** `aktar` seçiliyken parayı gönderen kendi hesabın */
  fromAccountId?: string | null
}

/** Bir arz hesabının bu arz için durumu */
export interface AccountNeed {
  accountId: string
  accountName: string
  /** İstenen lot × lot fiyatı — hesaptan bloke edilecek tutar */
  required: number
  /** Bu arzın blokesi yokmuş gibi hesaplanan bakiye */
  available: number
  /** Bakiyenin yetmediği kısım; 0 ise hesaptaki para yeter */
  shortfall: number
}

export interface LedgerInsert {
  user_id: string
  account_id: string
  ipo_id?: string | null
  kind: string
  amount: number
  date: string
  transfer_id?: string | null
  note?: string | null
}

/** Kuruş artıklarını yok say — 0,004 altındaki fark eksik sayılmaz */
const EPS = 0.005

export const roundTRY = (n: number) => Math.round(n * 100) / 100

/** Arzın hesaba kendi yazdığı hareketler — bakiye "öncesi"ne dönerken geri alınır */
const SELF_KINDS = new Set(['talep', 'giris', 'transfer'])

/**
 * Arza katılan her hesap için ne kadar gerekiyor, elinde ne var, açık ne
 * kadar.
 *
 * Bakiye hesaplanırken bu arzın o hesaba kendi yazdığı satırlar (blokesi ve
 * daha önce seçilmiş talep karşılığı) geri alınır — yoksa açık bir arzı
 * ikinci kez düzenlerken kendi blokesini açık, kendi aktardığı parayı da
 * mevcut bakiye sayar, açık her seferinde farklı çıkardı. `iade` ve `satis`
 * bilerek dokunulmadan bırakılır: onlar gerçekten hesaba dönmüş paradır.
 */
export function accountNeeds(
  ipo: IpoRow,
  entries: IpoEntry[],
  accountNames: Map<string, string>,
  balanceOf: Map<string, number>,
  ledger: LedgerRow[]
): AccountNeed[] {
  const lotPrice = Number(ipo.lot_price ?? 0)
  const own = new Map<string, number>()
  for (const l of ledger) {
    if (l.ipo_id !== ipo.id || !SELF_KINDS.has(l.kind)) continue
    own.set(l.account_id, (own.get(l.account_id) ?? 0) + Number(l.amount))
  }

  return entries
    .filter((e) => e.ipo_id === ipo.id && e.participated)
    .map((e) => {
      const required = roundTRY(Number(e.requested_lot) * lotPrice)
      // bu arzın yazdığı satırlar çıkarılınca talep öncesi bakiyeye dönülür
      const available = roundTRY((balanceOf.get(e.account_id) ?? 0) - (own.get(e.account_id) ?? 0))
      const gap = roundTRY(required - available)
      return {
        accountId: e.account_id,
        accountName: accountNames.get(e.account_id) ?? '—',
        required,
        available,
        shortfall: gap > EPS ? gap : 0,
      }
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName, 'tr'))
}

/** Açığı olan hesaplar — kaynak sorusu yalnızca bunlar için anlamlı */
export const shortNeeds = (needs: AccountNeed[]) => needs.filter((n) => n.shortfall > 0)

/** Hesabın parası talebi karşılıyorsa varsayılan "hesaptaki parayla" olsun */
export function defaultChoices(needs: AccountNeed[]): Record<string, FundingChoice> {
  const out: Record<string, FundingChoice> = {}
  for (const n of needs) out[n.accountId] = { source: n.shortfall > 0 ? 'aktar' : 'mevcut' }
  return out
}

/** Her hesaba blokesini yazan `talep` satırları */
export function talepRows(ipo: IpoRow, needs: AccountNeed[], date: string): LedgerInsert[] {
  return needs
    .filter((n) => n.required > EPS)
    .map((n) => ({
      user_id: ipo.user_id,
      account_id: n.accountId,
      ipo_id: ipo.id,
      kind: 'talep',
      amount: -n.required,
      date,
      note: `${ipo.name} — talep bloke`,
    }))
}

/**
 * Açığı kapatan para hareketleri.
 *
 * `mevcut` hiçbir satır üretmez — para zaten hesaptaydı, defterde yeni bir
 * hareket yok. `aktar` iki satırlık transfer çifti üretir (kaynaktan eksi,
 * arz hesabına artı) ve `transfer_id` ile eşleştirir; toplam varlığın
 * değişmez. `disari` tek bir `giris` satırı yazar, toplam o kadar artar.
 *
 * `newId` dışarıdan verilir ki test edilebilsin (tarayıcıda crypto.randomUUID).
 */
export function fundingRows(
  ipo: IpoRow,
  needs: AccountNeed[],
  choices: Record<string, FundingChoice>,
  date: string,
  newId: () => string
): LedgerInsert[] {
  const rows: LedgerInsert[] = []
  for (const n of needs) {
    if (n.shortfall <= 0) continue
    const choice = choices[n.accountId] ?? { source: 'mevcut' as FundingSource }
    if (choice.source === 'mevcut') continue

    const note = `${ipo.name} — talep karşılığı`
    if (choice.source === 'aktar') {
      if (!choice.fromAccountId) throw new Error(`${n.accountName}: parayı hangi hesaptan attığını seç.`)
      if (choice.fromAccountId === n.accountId) throw new Error(`${n.accountName}: kaynak ve hedef hesap aynı olamaz.`)
      const transfer_id = newId()
      rows.push(
        { user_id: ipo.user_id, account_id: choice.fromAccountId, ipo_id: ipo.id, kind: 'transfer', amount: -n.shortfall, date, transfer_id, note },
        { user_id: ipo.user_id, account_id: n.accountId, ipo_id: ipo.id, kind: 'transfer', amount: n.shortfall, date, transfer_id, note }
      )
    } else {
      rows.push({ user_id: ipo.user_id, account_id: n.accountId, ipo_id: ipo.id, kind: 'giris', amount: n.shortfall, date, note })
    }
  }
  return rows
}

/**
 * Bir arzda hâlâ bloke duran para: talep − iade.
 *
 * Dağıtım açıklanmadan önce bu, talebin tamamıdır ve para aracı kurumda
 * bekler — senin paran olduğu için net varlığa sayılır. Dağıtımdan sonra
 * kalan tutar düşen lotun maliyetidir; o para artık pay olarak durur ve
 * "elde tutulan hisse" kaleminde sayıldığı için burada sayılmaz.
 */
export function blockedByIpo(ledger: LedgerRow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of ledger) {
    if (!l.ipo_id || (l.kind !== 'talep' && l.kind !== 'iade')) continue
    m.set(l.ipo_id, (m.get(l.ipo_id) ?? 0) - Number(l.amount))
  }
  return m
}

/** Dağıtımı açıklanmamış arzlarda bekleyen toplam para */
export function totalBlocked(ipos: IpoRow[], ledger: LedgerRow[]): number {
  const blocked = blockedByIpo(ledger)
  let sum = 0
  for (const i of ipos) {
    if (i.status !== 'talep_verildi') continue
    sum += Math.max(blocked.get(i.id) ?? 0, 0)
  }
  return roundTRY(sum)
}
