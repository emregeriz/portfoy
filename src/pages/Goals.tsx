import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { usePortfolio } from '../hooks/usePortfolio'
import { useTable } from '../hooks/useTable'
import NumberInput from '../components/NumberInput'
import StatCard from '../components/StatCard'
import NetWorthChart from '../components/NetWorthChart'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { formatTRY, parseTRInput, toTRInput } from '../lib/currency'
import { todayISO } from '../lib/calc'
import {
  addMonths,
  annualFromMonthly,
  monthsBetween,
  monthsToReach,
  plannedValueAt,
  projectPlan,
  requiredMonthlyAdd,
  requiredMonthlyRate,
  type PlanResult,
} from '../lib/goal'
import type { Goal, GoalMetric } from '../types/db'

/**
 * Hedef — "şu tarihe kadar şu kadar" + birikim hesaplayıcısı.
 *
 * Üstte bugünkü resim (usePortfolio, Dashboard'la aynı sayı), altında
 * hedef kartları ve hesaplayıcı. Hesaplayıcı dört soruya cevap verir:
 *   süre   → bu parayla, bu eklemeyle, bu getiriyle N ay sonra ne olur
 *   hedef  → hedefe kaç ayda varırım
 *   aylık  → hedefe vadede varmak için aylık ne eklemeliyim
 *   getiri → hedefe vadede varmak için aylık % kaç getiri lazım
 * Sonuç tek tıkla hedef olarak kaydedilir; plan da hedefin içinde durur,
 * her ay "olması gereken" ile gerçek değer kıyaslanır.
 */

type CalcMode = 'sure' | 'hedef' | 'aylik' | 'getiri'

const MODES: { key: CalcMode; label: string; q: string }[] = [
  { key: 'sure', label: 'Ne olur?', q: 'Bu parayla N ay sonra ne kadar olur' },
  { key: 'hedef', label: 'Ne zaman?', q: 'Hedefe kaç ayda varırım' },
  { key: 'aylik', label: 'Aylık ne kadar?', q: 'Hedef için her ay ne eklemeliyim' },
  { key: 'getiri', label: '% kaç getiri?', q: 'Hedef için aylık getiri ne olmalı' },
]

const METRICS: { value: GoalMetric; label: string; hint: string }[] = [
  { value: 'net', label: 'Net değer', hint: 'Toplam varlık − borçlar (Dashboard ile aynı)' },
  { value: 'varlik', label: 'Toplam varlık', hint: 'Nakit + pozisyonlar + arz hesapları + bloke' },
  { value: 'nakit', label: 'Nakit', hint: 'Hesaplardaki para; arz hesapları ve bloke dahil' },
  { value: 'pozisyon', label: 'Yatırım pozisyonları', hint: 'Fon / hisse / snapshot kalemlerinin değeri' },
  { value: 'manuel', label: 'Elle girerim', hint: 'İlerlemeyi kendin yazarsın' },
]
const metricLabel = (m: GoalMetric) => METRICS.find((x) => x.value === m)?.label ?? m

const fmtPct = (n: number, d = 2) =>
  n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: d })
const fmtDay = (iso: string) => format(parseISO(iso), 'd MMM yyyy', { locale: tr })
const fmtMonth = (iso: string) => format(parseISO(iso), 'MMM yyyy', { locale: tr })
const fmtMonths = (m: number) => {
  const y = Math.floor(m / 12)
  const r = m % 12
  if (y && r) return `${y} yıl ${r} ay`
  if (y) return `${y} yıl`
  return `${r} ay`
}
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000)

type Status = 'tamamlandi' | 'ulasildi' | 'suresi_doldu' | 'yolunda' | 'geride' | 'devam'
const STATUS: Record<Status, { label: string; tone: string }> = {
  tamamlandi: { label: 'Tamamlandı', tone: 'pos' },
  ulasildi: { label: 'Hedefe ulaşıldı', tone: 'pos' },
  suresi_doldu: { label: 'Süresi doldu', tone: 'neg' },
  yolunda: { label: 'Yolunda', tone: 'accent' },
  geride: { label: 'Plandan geride', tone: 'warn' },
  devam: { label: 'Devam ediyor', tone: 'muted' },
}

interface GoalForm {
  title: string
  target_amount: string
  target_date: string
  metric: GoalMetric
  manual_value: string
  start_amount: string
  start_date: string
  monthly_add: string
  monthly_rate: string
  add_raise: string
  note: string
}

const emptyForm = (today: string): GoalForm => ({
  title: '',
  target_amount: '',
  target_date: addMonths(today, 12),
  metric: 'net',
  manual_value: '',
  start_amount: '',
  start_date: today,
  monthly_add: '',
  monthly_rate: '',
  add_raise: '',
  note: '',
})

const formOf = (g: Goal): GoalForm => ({
  title: g.title,
  target_amount: toTRInput(Number(g.target_amount)),
  target_date: g.target_date,
  metric: g.metric,
  manual_value: toTRInput(g.manual_value == null ? null : Number(g.manual_value)),
  start_amount: toTRInput(Number(g.start_amount)),
  start_date: g.start_date,
  monthly_add: toTRInput(Number(g.monthly_add)),
  monthly_rate: toTRInput(Number(g.monthly_rate)),
  add_raise: toTRInput(Number(g.add_raise ?? 0)),
  note: g.note ?? '',
})

type ModalState = { type: 'goal'; id: string | null; form: GoalForm } | { type: 'progress'; goal: Goal } | null

/** Anapara / getiri oranı — örnek görseldeki iki renkli çubuk */
function SplitBar({ contributed, gain }: { contributed: number; gain: number }) {
  const total = contributed + Math.max(gain, 0)
  if (!(total > 0)) return null
  const a = Math.round((contributed / total) * 100)
  const g = 100 - a
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-pos/70" /> Anapara
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-accent" /> Getiri
        </span>
      </div>
      <div className="h-12 w-full rounded-lg overflow-hidden flex text-xs font-semibold text-white">
        <div className="bg-pos/70 grid place-items-center min-w-[3rem]" style={{ width: `${a}%` }}>
          <div className="text-center leading-tight">
            Anapara
            <div>%{a}</div>
          </div>
        </div>
        <div className="bg-accent grid place-items-center min-w-[3rem]" style={{ width: `${g}%` }}>
          <div className="text-center leading-tight">
            Getiri
            <div>%{g}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Ay ay plan tablosu — hesaplayıcıda ve hedef kartında ortak */
function PlanTable({ plan, showAll, onToggle, elapsed }: { plan: PlanResult; showAll: boolean; onToggle: () => void; elapsed?: number }) {
  const rows = showAll ? plan.rows : plan.rows.slice(0, 12)
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr>
            <th className="th">Ay</th>
            <th className="th text-right">Dönem başı</th>
            <th className="th text-right">Getiri</th>
            <th className="th text-right">Eklenen</th>
            <th className="th text-right">Dönem sonu</th>
            <th className="th text-right">Yatırılan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const yearEnd = r.month % 12 === 0
            const isNow = elapsed != null && r.month === elapsed
            return (
              <tr
                key={r.month}
                className={`${yearEnd ? 'bg-surface2/50 font-medium' : ''} ${isNow ? 'ring-1 ring-inset ring-accent/50' : ''}`}
              >
                <td className="td whitespace-nowrap">
                  {r.month}
                  <span className="ml-2 text-xs text-muted">{fmtMonth(r.date)}</span>
                  {isNow && <span className="ml-2 text-xs text-accent">bu ay</span>}
                </td>
                <td className="td text-right num">{formatTRY(r.opening)}</td>
                <td className={`td text-right num ${r.gain >= 0 ? 'text-pos' : 'text-neg'}`}>{formatTRY(r.gain)}</td>
                <td className="td text-right num text-muted">{formatTRY(r.added)}</td>
                <td className="td text-right num font-medium">{formatTRY(r.closing)}</td>
                <td className="td text-right num text-muted">{formatTRY(r.contributed)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {plan.rows.length > 12 && (
        <button className="btn-ghost text-xs mt-3" onClick={onToggle}>
          {showAll ? 'İlk 12 ayı göster' : `Kalan ${plan.rows.length - 12} ayı göster`}
        </button>
      )}
    </div>
  )
}

/** %25 / %50 / %75 / %100 eşiklerine plana göre hangi ay varılır */
function milestones(plan: PlanResult, target: number) {
  if (!(target > 0)) return []
  return [25, 50, 75, 100].map((pct) => {
    const need = (target * pct) / 100
    const row = plan.rows.find((r) => r.closing >= need)
    return { pct, need, row }
  })
}

export default function Goals() {
  const { user } = useAuth()
  const userId = user?.id ?? ''
  const today = todayISO()
  const p = usePortfolio(userId)
  const goals = useTable<Goal>('goals', { userId, orderBy: 'target_date', ascending: true })

  // ------------------------------------------------------- hesaplayıcı
  const [mode, setMode] = useState<CalcMode>('sure')
  const [start, setStart] = useState('100.000')
  const [add, setAdd] = useState('10.000')
  const [rate, setRate] = useState('2')
  const [months, setMonths] = useState('24')
  const [target, setTarget] = useState('1.000.000')
  const [raise, setRaise] = useState('')
  const [infl, setInfl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAllRows, setShowAllRows] = useState(false)
  const [showTable, setShowTable] = useState(false)

  const calc = useMemo(() => {
    const S = parseTRInput(start)
    const A = parseTRInput(add)
    const R = parseTRInput(rate)
    const N = Math.max(0, Math.round(parseTRInput(months)))
    const T = parseTRInput(target)
    const Z = parseTRInput(raise)
    const I = parseTRInput(infl)
    let n = N
    let monthlyAdd = A
    let ratePct = R
    let solved: string | null = null
    let unreachable = false
    if (mode === 'hedef') {
      const m = monthsToReach(T, { start: S, monthlyAdd: A, monthlyRatePct: R, addRaisePct: Z }, today)
      if (m == null) {
        unreachable = true
        n = 0
      } else {
        n = m
        solved = m === 0 ? 'Zaten hedefin üstündesin' : `${fmtMonths(m)} · ${fmtMonth(addMonths(today, m))}`
      }
    } else if (mode === 'aylik') {
      monthlyAdd = requiredMonthlyAdd(T, S, R, N)
      solved = monthlyAdd > 0 ? `${formatTRY(monthlyAdd)} / ay` : 'Ekleme gerekmiyor — mevcut para yetiyor'
    } else if (mode === 'getiri') {
      const r = requiredMonthlyRate(T, S, A, N)
      if (r == null) unreachable = true
      else {
        ratePct = r
        solved = r === 0 ? 'Getiri gerekmiyor — eklemeler yetiyor' : `%${fmtPct(r)} / ay · yıllık bileşik %${fmtPct(annualFromMonthly(r), 1)}`
      }
    }
    const plan = projectPlan(
      { start: S, monthlyAdd, monthlyRatePct: ratePct, months: n, addRaisePct: Z, inflationPct: I },
      today
    )
    return { S, A: monthlyAdd, R: ratePct, n, T, Z, I, plan, solved, unreachable }
  }, [mode, start, add, rate, months, target, raise, infl, today])

  const chartData = useMemo(() => {
    const rows = [
      { date: today, toplam: calc.S, anapara: calc.S, hedef: calc.T },
      ...calc.plan.rows.map((r) => ({ date: r.date, toplam: r.closing, anapara: r.contributed, hedef: calc.T })),
    ]
    return rows
  }, [calc, today])
  const chartSeries = useMemo(() => {
    const s = [
      { key: 'toplam', label: 'Toplam', color: '#22c55e' },
      { key: 'anapara', label: 'Anapara', color: '#94a3b8' },
    ]
    if (mode !== 'sure' && calc.T > 0) s.push({ key: 'hedef', label: 'Hedef', color: '#f59e0b' })
    return s
  }, [mode, calc.T])

  const calcMilestones = useMemo(
    () => (mode === 'sure' ? milestones(calc.plan, calc.plan.final) : milestones(calc.plan, calc.T)),
    [mode, calc]
  )

  // ---------------------------------------------------------- hedefler
  const currentOf = (g: Goal): number => {
    switch (g.metric) {
      case 'manuel':
        return Number(g.manual_value ?? 0)
      case 'varlik':
        return p.liveAssets
      case 'nakit':
        return p.cashTotal
      case 'pozisyon':
        return p.tradeTotals.value + (p.live?.total ?? 0)
      default:
        return p.liveNet ?? p.liveAssets
    }
  }

  const rows = useMemo(
    () =>
      goals.rows.map((g) => {
        const target = Number(g.target_amount)
        const cur = currentOf(g)
        const pct = target > 0 ? Math.max(Math.min(cur / target, 1), 0) : 0
        const remaining = Math.max(target - cur, 0)
        const monthsLeft = monthsBetween(today, g.target_date)
        const daysLeft = daysBetween(today, g.target_date)
        const hasPlan = Number(g.monthly_add) > 0 || Number(g.monthly_rate) > 0
        const planned = hasPlan ? plannedValueAt(g, g.target_date, today) : null
        const requiredAdd =
          remaining > 0 && monthsLeft > 0 ? requiredMonthlyAdd(target, cur, Number(g.monthly_rate), monthsLeft) : null
        let status: Status = 'devam'
        if (g.is_done) status = 'tamamlandi'
        else if (cur >= target) status = 'ulasildi'
        else if (daysLeft < 0) status = 'suresi_doldu'
        else if (planned != null) status = cur >= planned * 0.98 ? 'yolunda' : 'geride'
        return { g, target, cur, pct, remaining, monthsLeft, daysLeft, hasPlan, planned, requiredAdd, status }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goals.rows, p.liveNet, p.liveAssets, p.cashTotal, p.tradeTotals.value, p.live, today]
  )
  const active = rows.filter((r) => r.status !== 'tamamlandi')
  const nearest = active.filter((r) => r.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft)[0] ?? null

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedAllRows, setExpandedAllRows] = useState<Set<string>>(new Set())
  const toggle = (id: string, set: Set<string>, setter: (s: Set<string>) => void) => {
    const n = new Set(set)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setter(n)
  }

  // ------------------------------------------------------------- modal
  const [modal, setModal] = useState<ModalState>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progressValue, setProgressValue] = useState('')

  const setForm = (patch: Partial<GoalForm>) => {
    if (modal?.type !== 'goal') return
    setModal({ ...modal, form: { ...modal.form, ...patch } })
  }

  const openNew = () => {
    setFormError(null)
    setModal({ type: 'goal', id: null, form: emptyForm(today) })
  }
  const openEdit = (g: Goal) => {
    setFormError(null)
    setModal({ type: 'goal', id: g.id, form: formOf(g) })
  }
  /** Hesaplayıcıdaki senaryo hedef olur — plan alanları dolu gelir */
  const saveFromCalc = () => {
    setFormError(null)
    const targetAmount = mode === 'sure' ? calc.plan.final : calc.T
    setModal({
      type: 'goal',
      id: null,
      form: {
        ...emptyForm(today),
        title: mode === 'sure' ? `${fmtMonths(calc.n)} birikim planı` : `${formatTRY(calc.T)} hedefi`,
        target_amount: toTRInput(Math.round(targetAmount)),
        target_date: addMonths(today, Math.max(calc.n, 1)),
        start_amount: toTRInput(Math.round(calc.S)),
        start_date: today,
        monthly_add: toTRInput(Math.round(calc.A)),
        monthly_rate: toTRInput(Number(calc.R.toFixed(3))),
        add_raise: toTRInput(calc.Z),
      },
    })
  }
  const openProgress = (g: Goal) => {
    setFormError(null)
    setProgressValue(toTRInput(g.manual_value == null ? null : Number(g.manual_value)))
    setModal({ type: 'progress', goal: g })
  }

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setFormError(null)
    try {
      await fn()
      setModal(null)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitGoal = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'goal') return
    const f = modal.form
    const values = {
      user_id: userId,
      title: f.title.trim(),
      target_amount: parseTRInput(f.target_amount),
      target_date: f.target_date,
      metric: f.metric,
      manual_value: f.metric === 'manuel' ? parseTRInput(f.manual_value) : null,
      start_amount: parseTRInput(f.start_amount),
      start_date: f.start_date || today,
      monthly_add: parseTRInput(f.monthly_add),
      monthly_rate: parseTRInput(f.monthly_rate),
      add_raise: parseTRInput(f.add_raise),
      note: f.note.trim() || null,
    }
    if (!values.title) return setFormError('Hedefe bir ad ver.')
    if (!(values.target_amount > 0)) return setFormError('Hedef tutar sıfırdan büyük olmalı.')
    if (!values.target_date) return setFormError('Hedef tarihi seç.')
    void guard(() => (modal.id ? goals.update(modal.id, values) : goals.insert(values)))
  }

  const submitProgress = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'progress') return
    void guard(() => goals.update(modal.goal.id, { manual_value: parseTRInput(progressValue) }))
  }

  const toggleDone = (g: Goal) => void goals.update(g.id, { is_done: !g.is_done })
  const del = (g: Goal) => {
    if (!confirm(`"${g.title}" silinsin mi?`)) return
    void goals.remove(g.id)
  }

  if (goals.loading) return <Spinner />

  const tableMissing = goals.error && /does not exist|schema cache/i.test(goals.error)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hedef"
        subtitle="Nereye, ne zaman, nasıl — hedeflerin ve birikim hesaplayıcısı"
        actions={
          <button className="btn-primary" onClick={openNew}>
            + Hedef ekle
          </button>
        }
      />

      {tableMissing ? (
        <ErrorBox message="goals tablosu yok — supabase/hedef.sql dosyasını SQL Editor'de çalıştır." />
      ) : (
        goals.error && <ErrorBox message={goals.error} />
      )}
      {formError && !modal && <ErrorBox message={formError} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Net değer · bugün" value={p.liveNet ?? p.liveAssets} hint="Dashboard ile aynı hesap" />
        <StatCard
          title="Toplam varlık"
          value={p.liveAssets}
          hint={`${formatTRY(p.cashTotal)} nakit · ${formatTRY(p.tradeTotals.value)} pozisyon`}
        />
        <StatCard
          title="Hedefler"
          value={`${active.length} aktif`}
          hint={`${rows.length - active.length} tamamlandı · ${rows.filter((r) => r.status === 'yolunda').length} yolunda`}
        />
        <StatCard
          title="En yakın hedef"
          value={nearest ? nearest.g.title : '—'}
          tone={nearest && nearest.daysLeft <= 30 ? 'warn' : 'neutral'}
          hint={
            nearest
              ? `${nearest.daysLeft} gün · ${formatTRY(nearest.remaining)} kaldı`
              : 'Tarihi gelecekte olan hedef yok'
          }
        />
      </div>

      {/* ------------------------------------------------------ hedefler */}
      <Card title="Hedeflerim" actions={<span className="text-xs text-muted">{rows.length} hedef</span>}>
        {rows.length === 0 ? (
          <Empty>
            Henüz hedef yok. "+ Hedef ekle" ile yaz ya da aşağıdaki hesaplayıcıda bir senaryo kurup
            "Hedef olarak kaydet" de.
          </Empty>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const { g } = r
              const st = STATUS[r.status]
              const open = expanded.has(g.id)
              const plan =
                r.hasPlan && monthsBetween(g.start_date, g.target_date) > 0
                  ? projectPlan(
                      {
                        start: Number(g.start_amount),
                        monthlyAdd: Number(g.monthly_add),
                        monthlyRatePct: Number(g.monthly_rate),
                        months: monthsBetween(g.start_date, g.target_date),
                        addRaisePct: Number(g.add_raise ?? 0),
                      },
                      g.start_date
                    )
                  : null
              const elapsed = monthsBetween(g.start_date, today)
              const ms = plan ? milestones(plan, r.target) : []
              return (
                <div key={g.id} className={`rounded-lg border border-border p-4 ${g.is_done ? 'opacity-70' : ''}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{g.title}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <span className="text-xs text-muted">{metricLabel(g.metric)}</span>
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        {fmtDay(g.target_date)} ·{' '}
                        {r.daysLeft >= 0 ? `${r.daysLeft} gün (${fmtMonths(r.monthsLeft)}) kaldı` : `${-r.daysLeft} gün geçti`}
                        {g.note && <span> · {g.note}</span>}
                      </div>
                    </div>
                    <div className="inline-flex flex-wrap gap-1">
                      {g.metric === 'manuel' && (
                        <button className="btn-ghost text-xs" onClick={() => openProgress(g)}>
                          İlerleme gir
                        </button>
                      )}
                      <button className="btn-ghost text-xs" onClick={() => openEdit(g)}>
                        Düzenle
                      </button>
                      <button className="btn-ghost text-xs" onClick={() => toggleDone(g)}>
                        {g.is_done ? 'Geri aç' : 'Tamamlandı'}
                      </button>
                      <button className="btn-danger text-xs" onClick={() => del(g)}>
                        Sil
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <span className="text-2xl font-semibold num">{formatTRY(r.cur)}</span>
                      <span className="text-muted num"> / {formatTRY(r.target)}</span>
                    </div>
                    <span className="num text-sm font-medium">%{fmtPct(r.pct * 100, 1)}</span>
                  </div>
                  <div className="mt-1.5 h-2.5 w-full rounded-full bg-surface2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${r.pct >= 1 ? 'bg-pos' : r.status === 'geride' ? 'bg-amber-500' : 'bg-accent'}`}
                      style={{ width: `${Math.max(r.pct * 100, r.pct > 0 ? 1 : 0)}%` }}
                    />
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
                    <span>
                      Kalan <span className="text-ink num">{formatTRY(r.remaining)}</span>
                    </span>
                    {r.requiredAdd != null && (
                      <span>
                        Yetişmek için aylık{' '}
                        <span className="text-ink num">{formatTRY(r.requiredAdd)}</span>
                        {Number(g.monthly_rate) > 0 && <span> (%{fmtPct(Number(g.monthly_rate))} aylık getiriyle)</span>}
                      </span>
                    )}
                    {r.planned != null && (
                      <span>
                        Plana göre bugün <span className="text-ink num">{formatTRY(r.planned)}</span> olmalıydı ·{' '}
                        <span className={r.cur >= r.planned ? 'text-pos' : 'text-neg'}>
                          {r.cur >= r.planned ? '+' : '−'}
                          {formatTRY(Math.abs(r.cur - r.planned))}
                        </span>
                      </span>
                    )}
                    {plan && (
                      <button className="text-accent hover:underline" onClick={() => toggle(g.id, expanded, setExpanded)}>
                        {open ? 'Planı gizle ▴' : 'Planı gör ▾'}
                      </button>
                    )}
                  </div>

                  {open && plan && (
                    <div className="mt-4 space-y-4 border-t border-border pt-4">
                      <div className="grid gap-3 sm:grid-cols-3 text-sm">
                        <div>
                          <div className="text-xs text-muted">Plan</div>
                          <div>
                            {formatTRY(Number(g.start_amount))} başlangıç · {formatTRY(Number(g.monthly_add))}/ay ·
                            %{fmtPct(Number(g.monthly_rate))} aylık
                            {Number(g.add_raise) > 0 && ` · yılda %${fmtPct(Number(g.add_raise))} zam`}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted">Plan sonu</div>
                          <div className="num">
                            {formatTRY(plan.final)}{' '}
                            <span className={`text-xs ${plan.final >= r.target ? 'text-pos' : 'text-neg'}`}>
                              {plan.final >= r.target ? 'hedefi karşılıyor' : `${formatTRY(r.target - plan.final)} açık`}
                            </span>
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted">Yatırılan / getiri</div>
                          <div className="num">
                            {formatTRY(plan.contributed)} / <span className="text-pos">{formatTRY(plan.gain)}</span>
                          </div>
                        </div>
                      </div>

                      {ms.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {ms.map((m) => (
                            <span
                              key={m.pct}
                              className={`rounded-full border px-2.5 py-1 text-xs ${
                                r.cur >= m.need ? 'border-pos/40 bg-pos/10 text-pos' : 'border-border text-muted'
                              }`}
                            >
                              %{m.pct} · {formatTRY(m.need)} ·{' '}
                              {m.row ? fmtMonth(m.row.date) : 'plan dışında'}
                              {r.cur >= m.need && ' ✓'}
                            </span>
                          ))}
                        </div>
                      )}

                      <NetWorthChart
                        height={220}
                        data={[
                          { date: g.start_date, plan: Number(g.start_amount), hedef: r.target },
                          ...plan.rows.map((x) => ({ date: x.date, plan: x.closing, hedef: r.target })),
                        ]}
                        series={[
                          { key: 'plan', label: 'Plan', color: '#22c55e' },
                          { key: 'hedef', label: 'Hedef', color: '#f59e0b' },
                        ]}
                      />
                      <PlanTable
                        plan={plan}
                        showAll={expandedAllRows.has(g.id)}
                        onToggle={() => toggle(g.id, expandedAllRows, setExpandedAllRows)}
                        elapsed={elapsed}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ---------------------------------------------------- hesaplayıcı */}
      <Card
        title="Birikim hesaplayıcı"
        actions={
          <div className="flex flex-wrap gap-1">
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                title={m.q}
                onClick={() => setMode(m.key)}
                className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                  mode === m.key ? 'bg-accent/15 text-accent border-accent/40' : 'text-muted border-border hover:text-ink'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      >
        <p className="text-xs text-muted mb-3">{MODES.find((m) => m.key === mode)?.q}.</p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Başlangıç tutarı</label>
            <NumberInput className="w-full num" value={start} onChange={setStart} />
            <button
              type="button"
              className="mt-1 text-xs text-accent hover:underline"
              onClick={() => setStart(toTRInput(Math.round(p.liveNet ?? p.liveAssets)))}
            >
              Bugünkü net değerimle başla ({formatTRY(p.liveNet ?? p.liveAssets)})
            </button>
          </div>
          {mode !== 'aylik' && (
            <div>
              <label className="label">Aylık eklenen</label>
              <NumberInput className="w-full num" value={add} onChange={setAdd} />
            </div>
          )}
          {mode !== 'getiri' && (
            <div>
              <label className="label">Aylık getiri (%)</label>
              <NumberInput className="w-full num" value={rate} onChange={setRate} />
              <div className="mt-1 text-xs text-muted">
                yıllık bileşik %{fmtPct(annualFromMonthly(parseTRInput(rate)), 1)}
              </div>
            </div>
          )}
          {mode !== 'hedef' && (
            <div>
              <label className="label">Süre (ay)</label>
              <NumberInput className="w-full num" value={months} onChange={setMonths} />
              <div className="mt-1 text-xs text-muted">{fmtMonths(Math.max(0, Math.round(parseTRInput(months))))}</div>
            </div>
          )}
          {mode !== 'sure' && (
            <div>
              <label className="label">Hedef tutar</label>
              <NumberInput className="w-full num" value={target} onChange={setTarget} />
            </div>
          )}
        </div>

        <button
          type="button"
          className="mt-3 text-xs text-muted hover:text-ink"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '▾' : '▸'} Gelişmiş — yıllık zam, enflasyon
        </button>
        {showAdvanced && (
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="label">Aylık eklemeye yıllık zam (%)</label>
              <NumberInput className="w-full num" value={raise} onChange={setRaise} placeholder="0" />
              <div className="mt-1 text-xs text-muted">Her 12 ayda bir ekleme bu kadar artar (maaş zammı)</div>
            </div>
            <div>
              <label className="label">Yıllık enflasyon (%)</label>
              <NumberInput className="w-full num" value={infl} onChange={setInfl} placeholder="0" />
              <div className="mt-1 text-xs text-muted">Sonucu bugünkü paraya çevirir</div>
            </div>
          </div>
        )}

        {calc.unreachable ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            {mode === 'hedef'
              ? 'Bu parayla ve bu eklemeyle 50 yılda bile hedefe varılmıyor — eklemeyi ya da getiriyi artır.'
              : 'Bu vadede hedefe %50 aylık getiriyle bile varılmıyor — vadeyi uzat ya da eklemeyi artır.'}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {calc.solved && (
              <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
                <span className="text-muted">Cevap: </span>
                <span className="font-semibold text-accent">{calc.solved}</span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border px-3 py-2.5">
                <div className="text-xs text-muted uppercase tracking-wide">Toplam ulaşılan</div>
                <div className="text-xl font-semibold num mt-1">{formatTRY(calc.plan.final)}</div>
                {calc.I > 0 && (
                  <div className="text-xs text-muted mt-0.5">bugünkü parayla {formatTRY(calc.plan.finalReal)}</div>
                )}
              </div>
              <div className="rounded-lg border border-border px-3 py-2.5">
                <div className="text-xs text-muted uppercase tracking-wide">Yatırılan anapara</div>
                <div className="text-xl font-semibold num mt-1">{formatTRY(calc.plan.contributed)}</div>
                <div className="text-xs text-muted mt-0.5">
                  {formatTRY(calc.S)} + {calc.n} × {formatTRY(calc.A)}
                  {calc.Z > 0 && ' (zamlı)'}
                </div>
              </div>
              <div className="rounded-lg border border-border px-3 py-2.5">
                <div className="text-xs text-muted uppercase tracking-wide">Kazanılan getiri</div>
                <div className={`text-xl font-semibold num mt-1 ${calc.plan.gain >= 0 ? 'text-pos' : 'text-neg'}`}>
                  {formatTRY(calc.plan.gain)}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  %{fmtPct(calc.R)} aylık · %{fmtPct(annualFromMonthly(calc.R), 1)} yıllık
                </div>
              </div>
            </div>

            <SplitBar contributed={calc.plan.contributed} gain={calc.plan.gain} />

            {calc.plan.rows.length > 0 && (
              <div>
                <div className="text-xs text-muted mb-1">Toplam tutar (₺) · aya göre</div>
                <NetWorthChart data={chartData} series={chartSeries} height={260} />
              </div>
            )}

            {calcMilestones.length > 0 && calc.plan.rows.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {calcMilestones.map((m) => (
                  <span key={m.pct} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                    %{m.pct} · {formatTRY(m.need)} · {m.row ? `${m.row.month}. ay (${fmtMonth(m.row.date)})` : '—'}
                  </span>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-primary text-sm" onClick={saveFromCalc} disabled={calc.n === 0}>
                Hedef olarak kaydet
              </button>
              <button className="btn-ghost text-sm" onClick={() => setShowTable((v) => !v)}>
                {showTable ? 'Ay ay tabloyu gizle' : 'Ay ay tabloyu göster'}
              </button>
            </div>

            {showTable && calc.plan.rows.length > 0 && (
              <PlanTable plan={calc.plan} showAll={showAllRows} onToggle={() => setShowAllRows((v) => !v)} />
            )}
          </div>
        )}

        <p className="mt-4 text-xs text-muted">
          Getiri her ay dönem başı bakiyeye işler, ekleme ay sonunda eklenir — yani ilk ayın eklemesi
          ilk ayın getirisine katılmaz. Aylık %2 getiri yıllık bileşikte %26,8 eder; TL mevduat ya da
          fon getirisini aylığa çevirirken bunu hesaba kat. Vergi ve stopaj düşülmez.
        </p>
      </Card>

      {/* ------------------------------------------------------------ modal */}
      <Modal
        open={modal?.type === 'goal'}
        title={modal?.type === 'goal' && modal.id ? 'Hedefi düzenle' : 'Yeni hedef'}
        onClose={() => setModal(null)}
      >
        {modal?.type === 'goal' && (
          <form onSubmit={submitGoal} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Hedef adı</label>
                <input
                  className="w-full"
                  value={modal.form.title}
                  onChange={(e) => setForm({ title: e.target.value })}
                  placeholder="Örn. 2027 sonunda 2 milyon"
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Hedef tutar</label>
                <NumberInput className="w-full num" value={modal.form.target_amount} onChange={(v) => setForm({ target_amount: v })} />
              </div>
              <div>
                <label className="label">Hedef tarihi</label>
                <input
                  type="date"
                  className="w-full"
                  value={modal.form.target_date}
                  onChange={(e) => setForm({ target_date: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Ne ölçülsün?</label>
                <select
                  className="w-full"
                  value={modal.form.metric}
                  onChange={(e) => setForm({ metric: e.target.value as GoalMetric })}
                >
                  {METRICS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} — {m.hint}
                    </option>
                  ))}
                </select>
              </div>
              {modal.form.metric === 'manuel' && (
                <div className="sm:col-span-2">
                  <label className="label">Şu anki ilerleme</label>
                  <NumberInput className="w-full num" value={modal.form.manual_value} onChange={(v) => setForm({ manual_value: v })} />
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="text-xs font-medium text-muted">
                Plan (isteğe bağlı) — dolarsa her ay "olması gereken" çizilir, yolunda mısın görürsün
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Başlangıç tutarı</label>
                  <NumberInput className="w-full num" value={modal.form.start_amount} onChange={(v) => setForm({ start_amount: v })} />
                </div>
                <div>
                  <label className="label">Başlangıç tarihi</label>
                  <input
                    type="date"
                    className="w-full"
                    value={modal.form.start_date}
                    onChange={(e) => setForm({ start_date: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Aylık ekleme</label>
                  <NumberInput className="w-full num" value={modal.form.monthly_add} onChange={(v) => setForm({ monthly_add: v })} />
                </div>
                <div>
                  <label className="label">Aylık getiri (%)</label>
                  <NumberInput className="w-full num" value={modal.form.monthly_rate} onChange={(v) => setForm({ monthly_rate: v })} />
                </div>
                <div>
                  <label className="label">Eklemeye yıllık zam (%)</label>
                  <NumberInput className="w-full num" value={modal.form.add_raise} onChange={(v) => setForm({ add_raise: v })} placeholder="0" />
                </div>
              </div>
            </div>

            <div>
              <label className="label">Not</label>
              <input className="w-full" value={modal.form.note} onChange={(e) => setForm({ note: e.target.value })} />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button className="btn-primary" disabled={busy}>
                {busy ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'progress'} title="İlerleme gir" onClose={() => setModal(null)}>
        {modal?.type === 'progress' && (
          <form onSubmit={submitProgress} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <p className="text-sm text-muted">
              <span className="text-ink font-medium">{modal.goal.title}</span> · hedef {formatTRY(Number(modal.goal.target_amount))}
            </p>
            <div>
              <label className="label">Şu anki değer</label>
              <NumberInput className="w-full num" value={progressValue} onChange={setProgressValue} autoFocus />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button className="btn-primary" disabled={busy}>
                {busy ? 'Kaydediliyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
