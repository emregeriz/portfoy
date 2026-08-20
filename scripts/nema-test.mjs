#!/usr/bin/env node
/**
 * Nemalandırma matematiğinin testleri — para hesabı olduğu için elle
 * doğrulanmış senaryolar burada tutulur.
 *   npm run test:nema
 */
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const { planNema, projectNema, addDay, daysBetween, dailyRate } = await jiti.import(
  new URL('../src/lib/nema.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
)

let fails = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) fails++
}
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol

// 1) 100.000 TL, %34,5, 10 gün
const days = planNema({
  moves: [{ date: '2026-08-01', amount: 100000, kind: 'giris' }],
  annualPct: 34.5,
  today: '2026-08-10',
})
const sum = days.reduce((s, d) => s + d.amount, 0)
ok('10 gün faiz üretildi', days.length === 10, `${days.length} gün`)
ok('ilk gün ~94,52', near(days[0].amount, 100000 * 34.5 / 100 / 365), `${days[0].amount}`)
ok('bileşik toplam ~projectNema', near(sum, projectNema(100000, 34.5, 10), 0.2),
   `${sum.toFixed(2)} vs ${projectNema(100000, 34.5, 10).toFixed(2)}`)
ok('faiz her gün büyüyor', days[9].amount > days[0].amount)
ok('ilk gün para yattığı gün', days[0].date === '2026-08-01' && days[9].date === '2026-08-10')

// 2) İşlenmiş günler tekrar üretilmiyor
const withNema = [
  { date: '2026-08-01', amount: 100000, kind: 'giris' },
  ...days.slice(0, 4).map((d) => ({ date: d.date, amount: d.amount, kind: 'nema' })),
]
const rest = planNema({ moves: withNema, annualPct: 34.5, today: '2026-08-10' })
ok('kalan 6 gün üretildi', rest.length === 6, `${rest.length}`)
ok('kaldığı yerden devam', rest[0].date === '2026-08-05')
ok('toplam aynı kaldı',
   near(days.slice(0, 4).reduce((s, d) => s + d.amount, 0) + rest.reduce((s, d) => s + d.amount, 0), sum, 0.05))

// 3) Hesap boşalınca faiz duruyor; kalan faiz kırıntısı işlemeye devam eder
const emptied = planNema({
  moves: [
    { date: '2026-08-01', amount: 10000, kind: 'giris' },
    { date: '2026-08-03', amount: -10100, kind: 'cikis' },
  ],
  annualPct: 34.5,
  today: '2026-08-10',
})
ok('bakiye bitince faiz yok', emptied.every((d) => d.date < '2026-08-03'), JSON.stringify(emptied.map(d=>d.date)))

const partial = planNema({
  moves: [
    { date: '2026-08-01', amount: 10000, kind: 'giris' },
    { date: '2026-08-03', amount: -10000, kind: 'cikis' },
  ],
  annualPct: 34.5,
  today: '2026-08-10',
})
const after = partial.filter((d) => d.date >= '2026-08-03')
ok('anaparadan sonra sadece birikmiş faiz kazanıyor',
   after.length > 0 && after.every((d) => d.base < 25 && d.amount <= 0.02),
   `base=${after[0]?.base} amount=${after[0]?.amount}`)

// 4) Başlangıç tarihi ileri alınırsa öncesi işlemez
const late = planNema({
  moves: [{ date: '2026-08-01', amount: 50000, kind: 'giris' }],
  annualPct: 34.5,
  today: '2026-08-05',
  startFrom: '2026-08-04',
})
ok('startFrom öncesi atlandı', late.length === 2 && late[0].date === '2026-08-04', JSON.stringify(late.map(d=>d.date)))
ok('startFrom bakiyesi doğru', near(late[0].base, 50000, 0.01), `${late[0].base}`)

// 5) Oran 0 / hareket yok
ok('oran 0 → boş', planNema({ moves: [{ date: '2026-08-01', amount: 5, kind: 'giris' }], annualPct: 0, today: '2026-08-10' }).length === 0)
ok('hareket yok → boş', planNema({ moves: [], annualPct: 34.5, today: '2026-08-10' }).length === 0)

// 6) Gelecek tarihli today
ok('bugün ilk hareketten önceyse boş',
   planNema({ moves: [{ date: '2026-09-01', amount: 100, kind: 'giris' }], annualPct: 34.5, today: '2026-08-10' }).length === 0)

// 7) Küçük bakiye — 1 kuruşun altı yazılmaz
const tiny = planNema({ moves: [{ date: '2026-08-09', amount: 5, kind: 'giris' }], annualPct: 34.5, today: '2026-08-10' })
ok('kuruş altı faiz yazılmıyor', tiny.length === 0, JSON.stringify(tiny))

// 8) Tarih yardımcıları — ay/yıl sınırı
ok('addDay ay sonu', addDay('2026-01-31') === '2026-02-01')
ok('addDay yıl sonu', addDay('2026-12-31') === '2027-01-01')
ok('addDay geri', addDay('2026-03-01', -1) === '2026-02-28')
ok('daysBetween ay atlar', daysBetween('2026-01-31', '2026-03-01') === 29, String(daysBetween('2026-01-31', '2026-03-01')))
ok('dailyRate', near(dailyRate(34.5), 0.00094520548, 1e-9))

// 9) Yıllık büyüme mantıklı mı (bileşik 365 gün ≈ %41,2)
const yearly = projectNema(100000, 34.5, 365) / 100000 * 100
ok('365 günde ~%41 bileşik', yearly > 40 && yearly < 42, `%${yearly.toFixed(2)}`)

console.log(fails ? `\n${fails} test başarısız` : '\nTüm testler geçti')
process.exit(fails ? 1 : 0)
