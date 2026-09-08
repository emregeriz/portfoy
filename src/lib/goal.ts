/**
 * Birikim planı matematiği — Hedef sayfasındaki hesaplayıcı ve planlı
 * hedeflerin "bu ay olması gereken" çizgisi buradan beslenir.
 *
 * Ay döngüsü (aracı kurum hesaplayıcılarıyla aynı sıra):
 *   dönem başı → getiri = dönem başı × oran → ay sonunda ekleme
 *   dönem sonu = dönem başı + getiri + eklenen
 *
 * Yani ilk ayın eklemesi ilk ayın getirisine katılmaz; 500.000 ile
 * başlayıp %10 ve 50.000 eklemeyle ilk ay 600.000'e gelirsin.
 */

export interface PlanInput {
  /** Başlangıç tutarı (anapara) */
  start: number
  /** Her ay eklenen */
  monthlyAdd: number
  /** Aylık getiri, yüzde */
  monthlyRatePct: number
  /** Süre, ay */
  months: number
  /** Aylık eklemenin yıllık artışı, yüzde (maaş zammı) — her 12 ayda bir uygulanır */
  addRaisePct?: number
  /** Yıllık enflasyon, yüzde — bugünkü paraya çevirmek için */
  inflationPct?: number
}

export interface PlanRow {
  /** 1'den başlar */
  month: number
  /** O ayın sonu, ISO — grafiklerde x ekseni */
  date: string
  opening: number
  gain: number
  added: number
  closing: number
  /** Bugüne kadar cebinden çıkan toplam (başlangıç dahil) */
  contributed: number
  /** Bugünkü satın alma gücüyle dönem sonu */
  real: number
}

export interface PlanResult {
  rows: PlanRow[]
  final: number
  contributed: number
  gain: number
  /** Enflasyondan arındırılmış son değer */
  finalReal: number
}

/** ISO tarihe n ay ekler; ay sonuna sığmayan gün kırpılır (31 Oca → 28 Şub) */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(d, last)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function projectPlan(input: PlanInput, startDate: string): PlanResult {
  const r = Math.max(input.monthlyRatePct, -99) / 100
  const infl = Math.max(input.inflationPct ?? 0, 0) / 100
  const raise = Math.max(input.addRaisePct ?? 0, -99) / 100
  const months = Math.max(0, Math.floor(input.months))
  const rows: PlanRow[] = []
  let balance = Math.max(input.start, 0)
  let contributed = balance
  let add = Math.max(input.monthlyAdd, 0)
  for (let i = 1; i <= months; i++) {
    // Her 12. ayın başında ekleme zamlanır
    if (i > 1 && (i - 1) % 12 === 0) add = add * (1 + raise)
    const opening = balance
    const gain = opening * r
    const closing = opening + gain + add
    contributed += add
    const real = infl > 0 ? closing / Math.pow(1 + infl, i / 12) : closing
    rows.push({ month: i, date: addMonths(startDate, i), opening, gain, added: add, closing, contributed, real })
    balance = closing
  }
  const final = rows.length ? rows[rows.length - 1].closing : balance
  return {
    rows,
    final,
    contributed,
    gain: final - contributed,
    finalReal: rows.length ? rows[rows.length - 1].real : balance,
  }
}

/** Kaç ayda hedefe varılır — 600 ayda varılamıyorsa null */
export function monthsToReach(
  target: number,
  input: Omit<PlanInput, 'months'>,
  startDate: string,
  maxMonths = 600
): number | null {
  if (input.start >= target) return 0
  const r = input.monthlyRatePct / 100
  const raise = Math.max(input.addRaisePct ?? 0, -99) / 100
  let balance = input.start
  let add = input.monthlyAdd
  for (let i = 1; i <= maxMonths; i++) {
    if (i > 1 && (i - 1) % 12 === 0) add = add * (1 + raise)
    balance = balance * (1 + r) + add
    if (balance >= target) return i
  }
  void startDate
  return null
}

/**
 * Hedefe tam vadede varmak için aylık ne eklenmeli.
 * FV = S(1+r)^n + A·((1+r)^n − 1)/r  →  A = (FV − S(1+r)^n)·r / ((1+r)^n − 1)
 * Zam varsayılmaz (kapalı formül); 0 ya da eksi çıkarsa ekleme gerekmiyor demektir.
 */
export function requiredMonthlyAdd(target: number, start: number, monthlyRatePct: number, months: number): number {
  const n = Math.max(1, Math.floor(months))
  const r = monthlyRatePct / 100
  if (Math.abs(r) < 1e-9) return Math.max((target - start) / n, 0)
  const g = Math.pow(1 + r, n)
  return Math.max(((target - start * g) * r) / (g - 1), 0)
}

/**
 * Hedefe vadede varmak için gereken aylık getiri (yüzde). İkiye bölme;
 * %0–%50 aralığı dışına çıkıyorsa null.
 */
export function requiredMonthlyRate(target: number, start: number, monthlyAdd: number, months: number): number | null {
  const n = Math.max(1, Math.floor(months))
  const fv = (r: number) => {
    let b = start
    for (let i = 0; i < n; i++) b = b * (1 + r) + monthlyAdd
    return b
  }
  if (fv(0) >= target) return 0
  let lo = 0
  let hi = 0.5
  if (fv(hi) < target) return null
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2
    if (fv(mid) < target) lo = mid
    else hi = mid
  }
  return hi * 100
}

/** Aylık yüzdeyi yıllık bileşiğe çevirir: %2/ay → %26,8/yıl */
export const annualFromMonthly = (pct: number) => (Math.pow(1 + pct / 100, 12) - 1) * 100
/** Yıllık bileşiği aylığa: %30/yıl → %2,21/ay */
export const monthlyFromAnnual = (pct: number) => (Math.pow(1 + pct / 100, 1 / 12) - 1) * 100

/** İki ISO tarih arasındaki tam ay sayısı (en az 0) */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  let n = (ty - fy) * 12 + (tm - fm)
  if (td < fd) n -= 1
  return Math.max(n, 0)
}

/** Planlı hedefte bugün olması gereken değer — plan satırlarından ara değer */
export function plannedValueAt(
  goal: { start_amount: number; start_date: string; monthly_add: number; monthly_rate: number; add_raise?: number },
  target_date: string,
  today: string
): number | null {
  const months = monthsBetween(goal.start_date, target_date)
  if (months <= 0) return null
  const plan = projectPlan(
    {
      start: Number(goal.start_amount),
      monthlyAdd: Number(goal.monthly_add),
      monthlyRatePct: Number(goal.monthly_rate),
      months,
      addRaisePct: Number(goal.add_raise ?? 0),
    },
    goal.start_date
  )
  const elapsed = monthsBetween(goal.start_date, today)
  if (elapsed <= 0) return Number(goal.start_amount)
  const row = plan.rows[Math.min(elapsed, plan.rows.length) - 1]
  return row ? row.closing : plan.final
}
