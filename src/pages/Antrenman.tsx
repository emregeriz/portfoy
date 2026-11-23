import { useEffect, useMemo, useState, type CSSProperties } from 'react'

/**
 * Antrenman — bizim salon programı.
 *
 * Uygulamanın geri kalanından tamamen bağımsız: giriş istemez, menü/Layout
 * yok, tema tercihine bakmaz (hep koyu). Telefonda salonda açılıp kaydırarak
 * bakılsın diye tek sütun, büyük görsel, büyük dokunma alanı.
 *
 * Her kas grubunda bir ya da birkaç "slot" var. Bir slotta birden fazla
 * hareket varsa bunlar birbirinin alternatifidir — o gün hangisi boşsa onu
 * seçersin, seçim hatırlanır. Bacak gibi slotları ayrı olan gruplarda her
 * hareket yapılır.
 *
 * Görseller free-exercise-db'den (Unlicense / kamu malı): her hareketin
 * başlangıç ve bitiş karesi, `public/antrenman/<slug>-0|1.jpg`. İkisi
 * arasında geçiş yapılarak hareket gösterilir.
 *
 * "Yaptım" işaretleri ve alternatif seçimi yalnızca bu cihazın tarayıcısında
 * tutulur; işaretler güne bağlı, ertesi gün kendiliğinden sıfırlanır.
 */

interface Move {
  id: string
  /** Alternatif sekmesinde görünen kısa ad */
  short: string
  name: string
  /** İsmin altında Türkçe açıklama */
  sub?: string
  target: string
  cue: string
  img: string
}

interface Slot {
  id: string
  moves: Move[]
}

interface Group {
  key: string
  title: string
  color: string
  slots: Slot[]
}

const PROGRAM: Group[] = [
  {
    key: 'gogus',
    title: 'Göğüs',
    color: '#fb7185',
    slots: [
      {
        id: 'gogus-pres',
        moves: [
          {
            id: 'bench',
            short: 'Bench',
            name: 'Bench Press',
            sub: 'Düz sehpada barbell itiş',
            target: 'Göğüs · Ön omuz · Arka kol',
            cue: 'Kürek kemiklerini sık, ayaklar yere bassın. Bar göğsün ortasına kontrollü insin, patlayarak it.',
            img: 'bench',
          },
          {
            id: 'incline-bench',
            short: 'Incline',
            name: 'Incline Bench Press',
            sub: 'Eğimli sehpada barbell itiş',
            target: 'Üst göğüs · Ön omuz',
            cue: 'Sehpa 30–45°. Bar üst göğse insin, dirsekler gövdeden hafif içeride kalsın.',
            img: 'incline-bench',
          },
          {
            id: 'machine-bench',
            short: 'Makine',
            name: 'Machine Bench Press',
            sub: 'Makinede göğüs itiş',
            target: 'Göğüs · Arka kol',
            cue: 'Tutamaçlar göğüs hizasında olacak şekilde koltuğu ayarla. Kontrollü it, yavaş geri bırak.',
            img: 'machine-bench',
          },
        ],
      },
      {
        id: 'gogus-acis',
        moves: [
          {
            id: 'pullover',
            short: 'Pullover',
            name: 'Dumbbell Pullover',
            sub: 'Sehpada baş arkasına dumbbell',
            target: 'Göğüs · Kanat · Serratus',
            cue: 'Dirsekler hafif bükük ve sabit. Dumbbell’i baş arkasına esneterek indir, göğüs üstüne geri getir.',
            img: 'pullover',
          },
          {
            id: 'dumbbell-fly',
            short: 'Fly',
            name: 'Dumbbell Fly',
            sub: 'Düz sehpada dumbbell açış',
            target: 'Göğüs',
            cue: 'Dirsekler hafif bükük kalsın. Kollar yay çizerek açılsın, göğüste gerilmeyi hisset, üstte birleştir.',
            img: 'dumbbell-fly',
          },
          {
            id: 'machine-fly',
            short: 'Makine Fly',
            name: 'Machine Fly',
            sub: 'Pec deck / kelebek makinesi',
            target: 'Göğüs',
            cue: 'Göğsü dik tut, sırt pede yaslı. Tutamaçları önde birleştir, bir saniye sık, yavaş aç.',
            img: 'machine-fly',
          },
        ],
      },
    ],
  },
  {
    key: 'sirt',
    title: 'Sırt',
    color: '#38bdf8',
    slots: [
      {
        id: 'sirt-pulldown',
        moves: [
          {
            id: 'reverse-pulldown',
            short: 'Pulldown',
            name: 'Reverse Grip Lat Pulldown',
            sub: 'Ters tutuşla barı göğse çekiş',
            target: 'Kanat · Orta sırt · Biceps',
            cue: 'Avuç içleri sana dönük, omuz genişliğinde. Göğsü kaldır, barı üst göğse çek, dirsekleri aşağı-geri sür.',
            img: 'reverse-pulldown',
          },
        ],
      },
      {
        id: 'sirt-row',
        moves: [
          {
            id: 'cable-row',
            short: 'Row',
            name: 'Seated Cable Row',
            sub: 'Oturarak kabloda kürek çekiş',
            target: 'Orta sırt · Kanat · Arka omuz',
            cue: 'Göğüs dik, bel nötr, gövde sallanmasın. Tutamacı karına çek, kürek kemiklerini birleştir.',
            img: 'cable-row',
          },
        ],
      },
    ],
  },
  {
    key: 'omuz',
    title: 'Omuz',
    color: '#fbbf24',
    slots: [
      {
        id: 'omuz-pres',
        moves: [
          {
            id: 'shoulder-press',
            short: 'Pres',
            name: 'Seated Dumbbell Shoulder Press',
            sub: 'Hafif incline, oturarak dumbbell itiş',
            target: 'Ön & yan omuz · Arka kol',
            cue: 'Sırtlığı dikten bir kademe geri yatır (~75–80°). Dumbbell’ler kulak hizasından yukarı, tepede çarpıştırmadan it.',
            img: 'shoulder-press',
          },
        ],
      },
    ],
  },
  {
    key: 'biceps',
    title: 'Biceps',
    color: '#a78bfa',
    slots: [
      {
        id: 'biceps-curl',
        moves: [
          {
            id: 'barbell-curl',
            short: 'Düz Bar',
            name: 'Barbell Curl',
            sub: 'Ayakta düz barla curl',
            target: 'Biceps · Ön kol',
            cue: 'Omuz genişliğinde tut, dirsekler gövdeye yapışık. Gövdeyle sallanma, aşağı yavaş in.',
            img: 'barbell-curl',
          },
          {
            id: 'ez-curl',
            short: 'EZ-Bar',
            name: 'EZ-Bar Curl',
            sub: 'Ayakta Z-bar ile curl',
            target: 'Biceps · Brachialis',
            cue: 'Kırık bar bileği rahatlatır. Dirsekler sabit, yukarıda sık, kontrollü indir.',
            img: 'ez-curl',
          },
          {
            id: 'seated-db-curl',
            short: 'Oturarak DB',
            name: 'Seated Dumbbell Curl',
            sub: 'Sehpada oturarak dumbbell curl',
            target: 'Biceps',
            cue: 'Sehpanın ucunda dik otur, dirsekler yanda sabit. Bileği hafif dışa çevirerek kaldır, yavaş indir.',
            img: 'seated-db-curl',
          },
        ],
      },
    ],
  },
  {
    key: 'triceps',
    title: 'Triceps',
    color: '#34d399',
    slots: [
      {
        id: 'triceps-pushdown',
        moves: [
          {
            id: 'pushdown',
            short: 'Pushdown',
            name: 'Cable Triceps Pushdown',
            sub: 'Kabloda aşağı itiş (bar ya da halat)',
            target: 'Arka kol',
            cue: 'Dirsekler gövdeye yapışık ve sabit. Aşağıda kolu tam aç, bir an sık, yukarı yavaş bırak.',
            img: 'pushdown',
          },
        ],
      },
    ],
  },
  {
    key: 'bacak',
    title: 'Bacak',
    color: '#fb923c',
    slots: [
      {
        id: 'bacak-press',
        moves: [
          {
            id: 'leg-press',
            short: 'Leg Press',
            name: 'Leg Press',
            sub: 'Makinede bacak itiş',
            target: 'Ön bacak · Kalça',
            cue: 'Ayaklar kalça genişliğinde. Dizler içe kaçmasın, aşağıda bel pedden kalkmasın, yukarıda dizi kilitleme.',
            img: 'leg-press',
          },
        ],
      },
      {
        id: 'bacak-extension',
        moves: [
          {
            id: 'leg-extension',
            short: 'Extension',
            name: 'Leg Extension',
            sub: 'Oturarak ön bacak açış',
            target: 'Ön bacak (quadriceps)',
            cue: 'Ped ayak bileğinin hemen üstünde. Yukarıda 1 saniye sık, yavaş indir.',
            img: 'leg-extension',
          },
        ],
      },
      {
        id: 'bacak-curl',
        moves: [
          {
            id: 'leg-curl',
            short: 'Leg Curl',
            name: 'Leg Curl',
            sub: 'Makinede arka bacak bükme',
            target: 'Arka bacak (hamstring)',
            cue: 'Kalça pedden kalkmasın. Topukları kalçaya doğru çek, kontrollü geri bırak.',
            img: 'leg-curl',
          },
        ],
      },
    ],
  },
]

const ALL_SLOTS = PROGRAM.flatMap((g) => g.slots)
const MOVE_COUNT = ALL_SLOTS.reduce((n, s) => n + s.moves.length, 0)

const PICK_KEY = 'antrenman:pick'
const doneKey = () => `antrenman:done:${new Date().toLocaleDateString('sv-SE')}`

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* gizli sekme vb. — hafıza olmadan da çalışır */
  }
}

const CSS = `
@keyframes ant-frame { 0%, 45% { opacity: 0 } 50%, 95% { opacity: 1 } 100% { opacity: 0 } }
@keyframes ant-dot-a { 0%, 45% { opacity: 1 } 50%, 95% { opacity: .3 } 100% { opacity: 1 } }
@keyframes ant-dot-b { 0%, 45% { opacity: .3 } 50%, 95% { opacity: 1 } 100% { opacity: .3 } }
.ant-frame { animation: ant-frame 2.6s ease-in-out infinite; }
.ant-dot-a { animation: ant-dot-a 2.6s ease-in-out infinite; }
.ant-dot-b { animation: ant-dot-b 2.6s ease-in-out infinite; }
.ant-noscroll::-webkit-scrollbar { display: none; }
.ant-noscroll { scrollbar-width: none; }
@media (prefers-reduced-motion: reduce) {
  .ant-frame, .ant-dot-a, .ant-dot-b { animation: none; }
}
`

export default function Antrenman() {
  const [pick, setPick] = useState<Record<string, string>>(() => readJSON(PICK_KEY, {}))
  const [done, setDone] = useState<string[]>(() => readJSON(doneKey(), []))

  useEffect(() => {
    const prevTitle = document.title
    const prevBg = document.body.style.background
    document.title = 'Antrenman'
    document.body.style.background = '#0a0c11'
    return () => {
      document.title = prevTitle
      document.body.style.background = prevBg
    }
  }, [])

  const choose = (slotId: string, moveId: string) => {
    const next = { ...pick, [slotId]: moveId }
    setPick(next)
    writeJSON(PICK_KEY, next)
  }

  const toggle = (slotId: string) => {
    const next = done.includes(slotId) ? done.filter((d) => d !== slotId) : [...done, slotId]
    setDone(next)
    writeJSON(doneKey(), next)
  }

  const reset = () => {
    setDone([])
    writeJSON(doneKey(), [])
  }

  const doneCount = done.filter((d) => ALL_SLOTS.some((s) => s.id === d)).length
  const pct = Math.round((doneCount / ALL_SLOTS.length) * 100)

  const jump = (key: string) =>
    document.getElementById(`grup-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="min-h-full bg-[#0a0c11] text-white" style={{ fontFeatureSettings: "'tnum' 1" }}>
      <style>{CSS}</style>

      {/* Başlık */}
      <header className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(60% 80% at 10% 0%, rgba(251,113,133,.22), transparent 60%), radial-gradient(50% 70% at 90% 10%, rgba(56,189,248,.18), transparent 60%)',
          }}
        />
        <div className="relative mx-auto max-w-5xl px-4 pb-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/50">Salon programı</p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">Antrenman</h1>
          <p className="mt-1 text-sm text-white/55">
            {PROGRAM.length} kas grubu · {ALL_SLOTS.length} hareket · {MOVE_COUNT - ALL_SLOTS.length} alternatif
          </p>

          <div className="mt-4 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#fb7185] via-[#fbbf24] to-[#34d399] transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-sm font-semibold tabular-nums">
              {doneCount}/{ALL_SLOTS.length}
            </span>
            {doneCount > 0 && (
              <button
                onClick={reset}
                className="rounded-full px-2.5 py-1 text-xs font-medium text-white/60 ring-1 ring-white/15 active:bg-white/10"
              >
                Sıfırla
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Kas grubu çubuğu */}
      <nav className="sticky top-0 z-20 border-b border-white/5 bg-[#0a0c11]/85 backdrop-blur-md">
        <div className="ant-noscroll mx-auto flex max-w-5xl gap-2 overflow-x-auto px-4 py-3">
          {PROGRAM.map((g) => {
            const total = g.slots.length
            const d = g.slots.filter((s) => done.includes(s.id)).length
            return (
              <button
                key={g.key}
                onClick={() => jump(g.key)}
                className="flex shrink-0 items-center gap-2 rounded-full bg-white/[0.06] py-1.5 pl-2.5 pr-3 text-sm font-medium ring-1 ring-white/10 active:bg-white/10"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
                {g.title}
                {d === total && <span className="text-xs text-[#34d399]">✓</span>}
              </button>
            )
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-5xl space-y-9 px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-6">
        {PROGRAM.map((g, gi) => (
          <section key={g.key} id={`grup-${g.key}`} className="scroll-mt-20" style={{ '--acc': g.color } as CSSProperties}>
            <div className="mb-3 flex items-end justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm font-bold tabular-nums text-[color:var(--acc)]">
                  {String(gi + 1).padStart(2, '0')}
                </span>
                <h2 className="text-xl font-bold tracking-tight">{g.title}</h2>
              </div>
              <span className="text-xs text-white/45">
                {g.slots.length} hareket
                {g.slots.some((s) => s.moves.length > 1) && ' · alternatifli'}
              </span>
            </div>
            <div className="mb-4 h-px bg-gradient-to-r from-[color:var(--acc)] to-transparent opacity-50" />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.slots.map((slot, si) => (
                <SlotCard
                  key={slot.id}
                  slot={slot}
                  index={si + 1}
                  pickedId={pick[slot.id]}
                  onPick={(id) => choose(slot.id, id)}
                  done={done.includes(slot.id)}
                  onToggle={() => toggle(slot.id)}
                />
              ))}
            </div>
          </section>
        ))}

        <footer className="pt-2 text-center text-[11px] leading-relaxed text-white/30">
          Ağırlığı kontrollü indir, formu bozma. İstikrar &gt; ağırlık.
          <br />
          Görseller: free-exercise-db (kamu malı)
        </footer>
      </main>
    </div>
  )
}

function SlotCard({
  slot,
  index,
  pickedId,
  onPick,
  done,
  onToggle,
}: {
  slot: Slot
  index: number
  pickedId?: string
  onPick: (id: string) => void
  done: boolean
  onToggle: () => void
}) {
  const move = useMemo(() => slot.moves.find((m) => m.id === pickedId) ?? slot.moves[0], [slot, pickedId])
  const hasAlts = slot.moves.length > 1

  return (
    <article
      className={`overflow-hidden rounded-2xl bg-[#12151d] ring-1 transition ${
        done ? 'ring-[#34d399]/40' : 'ring-white/[0.07]'
      }`}
    >
      {/* Görsel: başlangıç ↔ bitiş karesi */}
      <div className="relative aspect-[3/2] overflow-hidden bg-black">
        <img
          src={`/antrenman/${move.img}-0.jpg`}
          alt={`${move.name} — başlangıç`}
          loading="lazy"
          className={`absolute inset-0 h-full w-full object-cover transition ${done ? 'opacity-40 grayscale' : ''}`}
        />
        <img
          src={`/antrenman/${move.img}-1.jpg`}
          alt=""
          aria-hidden
          loading="lazy"
          className={`ant-frame absolute inset-0 h-full w-full object-cover ${done ? 'grayscale' : ''}`}
          style={done ? { animation: 'none', opacity: 0 } : undefined}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#12151d] to-transparent" />

        <span className="absolute left-3 top-3 rounded-md bg-black/55 px-2 py-0.5 text-xs font-bold tabular-nums backdrop-blur-sm text-[color:var(--acc)]">
          {String(index).padStart(2, '0')}
        </span>

        {!done && (
          <span className="absolute bottom-2.5 left-3 flex gap-1">
            <span className="ant-dot-a h-1.5 w-4 rounded-full bg-white" />
            <span className="ant-dot-b h-1.5 w-4 rounded-full bg-white" />
          </span>
        )}

        <button
          onClick={onToggle}
          aria-pressed={done}
          aria-label={done ? 'Yapılmadı olarak işaretle' : 'Yaptım olarak işaretle'}
          className={`absolute right-3 top-3 flex h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold backdrop-blur-sm transition active:scale-95 ${
            done ? 'bg-[#34d399] text-[#06281b]' : 'bg-black/55 text-white ring-1 ring-white/25'
          }`}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.6}>
            <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {done ? 'Yapıldı' : 'Yaptım'}
        </button>
      </div>

      <div className="p-4 pt-3">
        {hasAlts && (
          <div className="ant-noscroll -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1">
            {slot.moves.map((m) => {
              const active = m.id === move.id
              return (
                <button
                  key={m.id}
                  onClick={() => onPick(m.id)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? 'bg-[color:var(--acc)] text-[#0a0c11]'
                      : 'bg-white/[0.06] text-white/65 ring-1 ring-white/10 active:bg-white/10'
                  }`}
                >
                  {m.short}
                </button>
              )
            })}
          </div>
        )}

        <h3 className={`text-lg font-bold leading-tight ${done ? 'text-white/50 line-through decoration-white/30' : ''}`}>
          {move.name}
        </h3>
        {move.sub && <p className="mt-0.5 text-sm text-white/50">{move.sub}</p>}

        <p className="mt-3 flex items-start gap-2 text-xs font-medium text-white/75">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--acc)]" />
          {move.target}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-white/55">{move.cue}</p>

        {hasAlts && (
          <p className="mt-3 text-[11px] text-white/35">
            {slot.moves.length} seçenekten birini yap
          </p>
        )}
      </div>
    </article>
  )
}
