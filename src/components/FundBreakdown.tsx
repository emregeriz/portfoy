import { useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { supabase } from '../lib/supabase'
import { Card, Empty } from './ui'
import { formatNumber, formatTRY } from '../lib/currency'
import { colorAt } from '../lib/calc'
import type { Holding } from '../lib/holdings'

/**
 * Fonların içinde ne var?
 *
 * Portföyde "fon" diye duran kalemin içi hisse, tahvil ve döviz olabiliyor.
 * Dağılım grafiği bunu göstermediği için gerçek hisse maruziyeti gizli
 * kalıyor: hisse fonu ile para piyasası fonu aynı dilimde birleşiyor.
 *
 * Veri fetch-fund-breakdown ile haftada bir tazeleniyor (Fonoloji).
 */

interface BreakdownRow {
  code: string
  name: string | null
  allocation: Record<string, number> | null
  holdings: { name: string; company: string | null; type: string; weight: number }[] | null
  as_of: string | null
}

/** Kaynağın "Hisse Senetleri" / "Yabancı Hisse Senetleri" gibi türleri */
const isStock = (type: string) => /hisse/i.test(type)

/** Listede başta gösterilecek kalem sayısı */
const SHOWN = 6

export default function FundBreakdown({ holdings }: { holdings: Holding[] }) {
  const [rows, setRows] = useState<BreakdownRow[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string | null>(null)

  // Portföydeki fonlar: sembol → güncel değer
  const funds = useMemo(() => {
    const m = new Map<string, number>()
    for (const h of holdings) {
      if (h.kind !== 'fon' || h.quantity <= 0) continue
      m.set(h.symbol, (m.get(h.symbol) ?? 0) + (h.value ?? h.costBasis))
    }
    return m
  }, [holdings])

  useEffect(() => {
    const codes = [...funds.keys()]
    if (!codes.length) {
      setRows([])
      setLoading(false)
      return
    }
    let iptal = false
    void (async () => {
      const { data } = await supabase
        .from('fund_breakdown')
        .select('code, name, allocation, holdings, as_of')
        .in('code', codes)
      if (!iptal) {
        setRows((data ?? []) as BreakdownRow[])
        setLoading(false)
      }
    })()
    return () => {
      iptal = true
    }
  }, [funds])

  /**
   * Fonların içindeki hisse tutarı. Kaynak her fonun yalnızca büyük
   * kalemlerini veriyor; kapsanmayan kısım hesaba katılmaz, o yüzden
   * bulunan tutar bir ALT SINIR.
   */
  const exposure = useMemo(() => {
    let stock = 0
    let covered = 0
    let total = 0
    for (const [code, value] of funds) {
      total += value
      const row = rows.find((r) => r.code === code)
      if (!row?.allocation) continue
      let stockPct = 0
      let sumPct = 0
      for (const [type, pct] of Object.entries(row.allocation)) {
        sumPct += pct
        if (isStock(type)) stockPct += pct
      }
      stock += (value * stockPct) / 100
      covered += (value * sumPct) / 100
    }
    return { stock, covered, total }
  }, [funds, rows])

  if (loading || !funds.size) return null

  const fmtAsOf = (iso: string | null) =>
    iso ? format(parseISO(iso), 'MMMM yyyy', { locale: tr }) : 'tarih yok'

  return (
    <Card
      title="Fonların içinde ne var?"
      actions={
        exposure.stock > 0 && (
          <span className="text-xs text-muted">
            Fonlar üzerinden hisse: <span className="text-ink num">{formatTRY(exposure.stock)}</span>
          </span>
        )
      }
    >
      {!rows.length ? (
        <Empty>
          İçerik verisi henüz çekilmedi. Haftalık iş pazartesi sabahı çalışıyor;
          beklemeden almak için fetch-fund-breakdown fonksiyonunu elle çağırabilirsin.
        </Empty>
      ) : (
        <div className="space-y-3">
          {[...funds.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([code, value]) => {
              const row = rows.find((r) => r.code === code)
              const alloc = Object.entries(row?.allocation ?? {}).sort((a, b) => b[1] - a[1])
              const kapsam = alloc.reduce((s, [, p]) => s + p, 0)
              const acik = open === code

              return (
                <div key={code} className="rounded-lg border border-border overflow-hidden">
                  <button
                    type="button"
                    className="w-full px-3 py-2 flex items-center justify-between gap-3 text-left hover:bg-surface2/60"
                    onClick={() => setOpen(acik ? null : code)}
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-ink">{code}</span>
                      <span className="text-xs text-muted ml-2 truncate">
                        {row?.name ?? '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      <span className="num text-sm">{formatTRY(value)}</span>
                      <span className="text-muted text-xs">{acik ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {!row ? (
                    <div className="px-3 pb-2 text-xs text-muted">İçerik verisi yok.</div>
                  ) : (
                    <>
                      {/* Tür dağılımı — tek satırlık yığılmış çubuk */}
                      <div className="px-3 pb-2">
                        <div className="h-2 rounded-full overflow-hidden flex bg-surface2">
                          {alloc.map(([type, pct], i) => (
                            <div
                              key={type}
                              style={{ width: `${pct}%`, background: colorAt(i) }}
                              title={`${type} · %${formatNumber(pct, 1)}`}
                            />
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-muted">
                          {alloc.map(([type, pct], i) => (
                            <span key={type} className="inline-flex items-center gap-1">
                              <span
                                className="inline-block w-2 h-2 rounded-sm"
                                style={{ background: colorAt(i) }}
                              />
                              {type} %{formatNumber(pct, 1)}
                            </span>
                          ))}
                        </div>
                      </div>

                      {acik && (
                        <div className="px-3 pb-3 space-y-1 border-t border-border pt-2">
                          {(row.holdings ?? []).slice(0, SHOWN).map((h) => (
                            <div key={h.name} className="flex justify-between gap-3 text-xs">
                              <span className="text-ink truncate" title={h.company ?? h.name}>
                                {h.name}
                                {isStock(h.type) && (
                                  <span className="text-muted"> · {formatTRY((value * h.weight) / 100)}</span>
                                )}
                              </span>
                              <span className="num text-muted">%{formatNumber(h.weight, 2)}</span>
                            </div>
                          ))}
                          {(row.holdings?.length ?? 0) > SHOWN && (
                            <div className="text-[11px] text-muted pt-0.5">
                              +{(row.holdings?.length ?? 0) - SHOWN} kalem daha
                            </div>
                          )}
                          <div className="text-[11px] text-muted pt-1">
                            {fmtAsOf(row.as_of)} verisi · kapsanan %{formatNumber(kapsam, 1)}
                            {kapsam < 95 && ' — kaynak yalnızca büyük kalemleri veriyor'}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}

          {exposure.stock > 0 && (
            <p className="text-xs text-muted pt-1 border-t border-border">
              Fonlarındaki <span className="text-ink num">{formatTRY(exposure.stock)}</span> hisseye
              denk geliyor — doğrudan tuttuğun hisselerin üstüne. Kaynak her fonun yalnızca büyük
              kalemlerini verdiği için ({formatNumber((exposure.covered / exposure.total) * 100, 0)}%
              kapsam) bu rakam alt sınırdır.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}
