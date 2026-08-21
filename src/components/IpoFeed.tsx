import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Badge, Card, Empty, ErrorBox, Spinner } from './ui'
import type { IpoFeedItem } from '../types/db'

/** Öne çıkan tek bilgi kutusu — fiyat gibi ana değer vurgulu gösterilir */
function FactTile({ label, value, accent = false }: { label: string; value: string | null; accent?: boolean }) {
  if (!value) return null
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        accent ? 'bg-accent/10 border-accent/25' : 'bg-surface2/60 border-border'
      }`}
    >
      <div
        className={`text-[10px] uppercase tracking-wide ${accent ? 'text-accent/80' : 'text-muted'}`}
      >
        {label}
      </div>
      <div
        className={`mt-0.5 font-semibold ${accent ? 'text-accent num text-base' : 'text-ink text-sm'}`}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * Dağıtım sonuçları. Kaynakta ilk iki satır başlıktır
 * (["Yatırımcı Grubu","Dağıtım"] + ["Kişi","Lot","Oran"]); tek hücrelik
 * satırlar dipnottur. Kalıp tutmazsa satırlar olduğu gibi basılır.
 */
function ResultsTable({ rows }: { rows: string[][] }) {
  const notes = rows.filter((r) => r.length === 1)
  const data = rows.filter((r) => r.length > 1)
  let header: string[] | null = null
  let body = data
  if (data.length >= 2 && data[0].length === 2 && data[1].length === 3) {
    header = [data[0][0], ...data[1]]
    body = data.slice(2)
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        {header && (
          <thead>
            <tr className="bg-surface2/60">
              {header.map((h, i) => (
                <th key={i} className={`th ${i > 0 ? 'text-right' : ''}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            <tr
              key={i}
              className={/toplam/i.test(r[0] ?? '') ? 'bg-surface2/40 font-semibold' : ''}
            >
              {r.map((c, j) => (
                <td key={j} className={`td ${j > 0 ? 'text-right num' : ''}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {notes.map((n, i) => (
        <p key={i} className="px-3 py-2 text-[11px] italic text-muted border-t border-border">
          {n[0]}
        </p>
      ))}
    </div>
  )
}

/**
 * Özet bilgi kartları. Metin satır satır ayrıştırılır: "- " ile başlayan
 * madde olur, "*" ile başlayan kaynak dipnotu olur, kalanlar düz satırdır.
 */
function OzetGrid({ items }: { items: { baslik: string; icerik: string }[] }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {items.map((o) => {
        const lines = o.icerik
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
        const bullets = lines.filter((l) => !l.startsWith('*'))
        const footnotes = lines.filter((l) => l.startsWith('*'))
        return (
          <div
            key={o.baslik}
            className="rounded-lg border border-border bg-surface2/40 p-3 border-l-2 border-l-accent/50"
          >
            <div className="text-xs font-semibold text-ink mb-1.5">{o.baslik}</div>
            <ul className="space-y-1">
              {bullets.map((l, i) => (
                <li key={i} className="text-xs leading-relaxed text-ink/90 flex gap-1.5">
                  {l.startsWith('- ') ? (
                    <>
                      <span className="text-accent shrink-0">•</span>
                      <span>{l.slice(2)}</span>
                    </>
                  ) : (
                    <span>{l}</span>
                  )}
                </li>
              ))}
            </ul>
            {footnotes.map((l, i) => (
              <p key={i} className="mt-1.5 text-[10px] italic text-muted">
                {l.replace(/^\*+\s*/, '')}
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}

const BADGES: Record<string, { label: string; tone: string }> = {
  yeni: { label: 'Yeni!', tone: 'accent' },
  gong: { label: 'Gong!', tone: 'pos' },
  ertelendi: { label: 'Ertelendi', tone: 'warn' },
}

/**
 * halkarz.com arz takvimi — ipo_feed önbelleğinden okur.
 * Veri fetch-halkarz Edge Function ile dolar: cron günde birkaç kez,
 * "Yenile" düğmesi istek anında çalıştırır.
 */
export default function IpoFeed({ onTrack }: { onTrack: (f: IpoFeedItem) => void }) {
  const [rows, setRows] = useState<IpoFeedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [showDrafts, setShowDrafts] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('ipo_feed').select('*').order('sort_order')
    if (error) {
      setError(
        /does not exist|schema cache/i.test(error.message)
          ? "ipo_feed tablosu yok — supabase/halkarz.sql dosyasını SQL Editor'de çalıştır."
          : error.message
      )
    } else {
      setRows((data ?? []) as IpoFeedItem[])
      setError(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Çekiciyi elle çalıştır — cron beklemeden günceli getirir */
  const refresh = async (slugs?: string[]) => {
    setRefreshing(true)
    setError(null)
    const { error } = await supabase.functions.invoke('fetch-halkarz', {
      body: slugs ? { slugs } : {},
    })
    if (error) {
      setError(
        `Çekici çalıştırılamadı — fetch-halkarz Edge Function deploy edildi mi? (${error.message})`
      )
    }
    await load()
    setRefreshing(false)
  }

  const main = useMemo(() => rows.filter((r) => !r.is_draft), [rows])
  const drafts = useMemo(() => rows.filter((r) => r.is_draft), [rows])
  const sel = rows.find((r) => r.slug === selected) ?? main[0] ?? null

  if (loading) return <Spinner />

  const listRow = (r: IpoFeedItem) => {
    const isSel = sel?.slug === r.slug
    const badge = r.badge ? BADGES[r.badge] : null
    return (
      <button
        key={r.slug}
        onClick={() => setSelected(r.slug)}
        aria-current={isSel ? 'true' : undefined}
        className={`block w-full text-left px-4 py-3 transition-colors ${
          isSel ? 'bg-accent/10' : 'hover:bg-surface2/60'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {r.bist_code && (
                <span className="text-[11px] font-semibold text-muted shrink-0">{r.bist_code}</span>
              )}
              <span className={`text-sm font-medium truncate ${isSel ? 'text-accent' : ''}`}>
                {r.name}
              </span>
            </div>
            <div className="text-xs text-muted mt-0.5">{r.date_text ?? '—'}</div>
          </div>
          <div className="shrink-0 text-right">
            {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
            {r.price_text && <div className="text-xs text-muted num mt-0.5">{r.price_text}</div>}
          </div>
        </div>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}

      {rows.length === 0 && !error ? (
        <Card>
          <Empty>
            Takvim boş. İlk kurulum: <code>supabase/halkarz.sql</code> dosyasını çalıştır,{' '}
            <code>fetch-halkarz</code> fonksiyonunu deploy et, sonra Yenile'ye bas.
            <div className="mt-3">
              <button className="btn-primary text-sm" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? 'Çekiliyor…' : '↻ Yenile'}
              </button>
            </div>
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12 items-start">
          {/* Sol: takvim listesi */}
          <Card className="p-0 lg:col-span-5 overflow-hidden">
            <header className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-ink">Arz Takvimi</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{main.length} arz</span>
                <button
                  className="btn-ghost text-xs"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                  title="halkarz.com'dan günceli çek"
                >
                  {refreshing ? 'Çekiliyor…' : '↻ Yenile'}
                </button>
              </div>
            </header>
            <div className="divide-y divide-border max-h-[560px] overflow-y-auto">
              {main.map(listRow)}
            </div>
            {drafts.length > 0 && (
              <div className="border-t border-border">
                <button
                  className="w-full text-left px-4 py-2.5 text-xs text-muted hover:text-ink"
                  onClick={() => setShowDrafts((v) => !v)}
                >
                  {showDrafts ? '▾' : '▸'} Taslak arzlar ({drafts.length}) — başvuru sürecindekiler
                </button>
                {showDrafts && (
                  <div className="divide-y divide-border max-h-[320px] overflow-y-auto border-t border-border">
                    {drafts.map(listRow)}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Sağ: seçili arzın detayı */}
          <Card className="lg:col-span-7">
            {!sel ? (
              <Empty>Soldan bir arz seç.</Empty>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{sel.name}</span>
                      {sel.bist_code && <span className="text-xs text-muted">{sel.bist_code}</span>}
                      {sel.badge && BADGES[sel.badge] && (
                        <Badge tone={BADGES[sel.badge].tone}>{BADGES[sel.badge].label}</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted mt-0.5">{sel.date_text ?? '—'}</div>
                  </div>
                  <div className="flex gap-2">
                    <a
                      href={sel.url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-ghost text-xs"
                    >
                      halkarz.com'da aç ↗
                    </a>
                    <button className="btn-primary text-xs" onClick={() => onTrack(sel)}>
                      + Takibe al
                    </button>
                  </div>
                </div>

                {!sel.detail ? (
                  <div className="rounded-lg border border-border bg-surface2/50 px-3 py-4 text-sm text-muted text-center">
                    Bu arzın detayı henüz çekilmedi.
                    <button
                      className="btn-ghost text-xs ml-2"
                      onClick={() => void refresh([sel.slug])}
                      disabled={refreshing}
                    >
                      {refreshing ? 'Çekiliyor…' : 'Detayı çek'}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Öne çıkan gerçekler — fiyat vurgulu */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <FactTile label="Arz fiyatı" value={sel.detail.fiyat} accent />
                      <FactTile label="Arz tarihi" value={sel.detail.tarih ?? sel.date_text} />
                      <FactTile label="Dağıtım" value={sel.detail.dagitim} />
                      <FactTile label="Pay" value={sel.detail.pay} />
                    </div>

                    {/* İkincil bilgiler */}
                    <div className="rounded-lg border border-border divide-y divide-border/60 text-sm">
                      {sel.detail.araci_kurum && (
                        <div className="flex items-start justify-between gap-4 px-3 py-2">
                          <span className="text-muted shrink-0">Aracı kurum</span>
                          <span className="text-right font-medium">
                            {sel.detail.araci_kurum}
                            {sel.detail.konsorsiyum && sel.detail.konsorsiyum.length > 0 && (
                              <span className="block text-xs text-muted font-normal mt-0.5">
                                Konsorsiyum: {sel.detail.konsorsiyum.join(' · ')}
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                      {sel.detail.pazar && (
                        <div className="flex justify-between gap-4 px-3 py-2">
                          <span className="text-muted">Pazar</span>
                          <span className="font-medium">{sel.detail.pazar}</span>
                        </div>
                      )}
                      {sel.detail.ilk_islem && (
                        <div className="flex justify-between gap-4 px-3 py-2">
                          <span className="text-muted">BIST ilk işlem tarihi</span>
                          <span className="font-medium">{sel.detail.ilk_islem}</span>
                        </div>
                      )}
                    </div>

                    {sel.detail.sonuclar && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
                          Dağıtım Sonuçları
                        </h3>
                        <ResultsTable rows={sel.detail.sonuclar} />
                      </div>
                    )}

                    {sel.detail.ozet && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
                          Özet Bilgiler
                        </h3>
                        <OzetGrid items={sel.detail.ozet} />
                      </div>
                    )}

                    <p className="text-[11px] text-muted">
                      Kaynak: halkarz.com
                      {sel.detail_fetched_at &&
                        ` · çekilme: ${new Date(sel.detail_fetched_at).toLocaleString('tr-TR')}`}
                    </p>
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
