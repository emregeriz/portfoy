import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { useAccounts } from '../hooks/useAccounts'
import { useAssets } from '../hooks/useAssets'
import { usePrices } from '../hooks/usePrices'
import { Card, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { CURRENCIES, formatNumber, formatTRY, parseAmount } from '../lib/currency'
import { todayISO } from '../lib/calc'
import type { AssetKind, Currency, LiabilityType, PositionWithRefs, Liability } from '../types/db'
import { POSITION_SELECT } from '../hooks/useSnapshots'

interface RowDraft {
  key: string
  account_id: string
  symbol: string
  kind: AssetKind
  quantity: string
  unit_price: string
  amount: string
  currency: Currency
  fx_rate: string
  note: string
}

interface DebtDraft {
  key: string
  title: string
  type: LiabilityType
  counterparty: string
  amount: string
  currency: Currency
  fx_rate: string
}

const KINDS: AssetKind[] = ['hisse', 'fon', 'doviz', 'altin', 'mevduat', 'kripto', 'diger']
const DEBT_TYPES: { value: LiabilityType; label: string }[] = [
  { value: 'kredi_karti', label: 'Kredi Kartı' },
  { value: 'kredi', label: 'Kredi' },
  { value: 'kisisel_borc', label: 'Kişisel Borç' },
  { value: 'fatura', label: 'Fatura' },
  { value: 'diger', label: 'Diğer' },
]

let counter = 0
const nextKey = () => `r${++counter}`

const emptyRow = (): RowDraft => ({
  key: nextKey(),
  account_id: '',
  symbol: '',
  kind: 'hisse',
  quantity: '',
  unit_price: '',
  amount: '',
  currency: 'TRY',
  fx_rate: '1',
  note: '',
})

const emptyDebt = (): DebtDraft => ({
  key: nextKey(),
  title: '',
  type: 'kredi_karti',
  counterparty: '',
  amount: '',
  currency: 'TRY',
  fx_rate: '1',
})

export default function NewSnapshot() {
  const { id: editId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { accounts } = useAccounts(user?.id)
  const { assets, ensureAsset } = useAssets()
  const { bySymbol, latestDate, refreshing, refresh } = usePrices()

  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<RowDraft[]>([emptyRow()])
  const [debts, setDebts] = useState<DebtDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(Boolean(editId))
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Düzenleme modunda mevcut snapshot'ı yükle
  useEffect(() => {
    if (!editId) return
    const run = async () => {
      setLoading(true)
      const { data: snap } = await supabase.from('snapshots').select('*').eq('id', editId).single()
      if (snap) {
        setDate(snap.snapshot_date)
        setNote(snap.note ?? '')
      }
      const { data: pos } = await supabase
        .from('positions')
        .select(POSITION_SELECT)
        .eq('snapshot_id', editId)
        .order('created_at')
      const list = (pos ?? []) as unknown as PositionWithRefs[]
      setRows(
        list.length
          ? list.map((p) => ({
              key: nextKey(),
              account_id: p.account_id ?? '',
              symbol: p.assets?.symbol ?? '',
              kind: (p.assets?.kind ?? 'diger') as AssetKind,
              quantity: p.quantity != null ? String(p.quantity) : '',
              unit_price: p.unit_price != null ? String(p.unit_price) : '',
              amount: String(p.amount),
              currency: p.currency,
              fx_rate: String(p.fx_rate ?? 1),
              note: p.note ?? '',
            }))
          : [emptyRow()]
      )
      const { data: liab } = await supabase.from('liabilities').select('*').eq('snapshot_id', editId)
      setDebts(
        ((liab ?? []) as Liability[]).map((l) => ({
          key: nextKey(),
          title: l.title,
          type: l.type,
          counterparty: l.counterparty ?? '',
          amount: String(l.amount),
          currency: l.currency,
          fx_rate: String(l.fx_rate ?? 1),
        }))
      )
      setLoading(false)
    }
    void run()
  }, [editId])

  const totalTRY = useMemo(
    () => rows.reduce((s, r) => s + parseAmount(r.amount) * (parseAmount(r.fx_rate) || 1), 0),
    [rows]
  )
  const totalDebtTRY = useMemo(
    () => debts.reduce((s, d) => s + parseAmount(d.amount) * (parseAmount(d.fx_rate) || 1), 0),
    [debts]
  )

  const setRow = (key: string, patch: Partial<RowDraft>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const setDebt = (key: string, patch: Partial<DebtDraft>) =>
    setDebts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  const copyFromLast = async () => {
    if (!user) return
    setError(null)
    const { data: snap } = await supabase
      .from('snapshots')
      .select('id, snapshot_date')
      .eq('user_id', user.id)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!snap) {
      setError('Kopyalanacak önceki kayıt bulunamadı.')
      return
    }
    const { data: pos } = await supabase
      .from('positions')
      .select(POSITION_SELECT)
      .eq('snapshot_id', snap.id)
      .order('created_at')
    const list = (pos ?? []) as unknown as PositionWithRefs[]
    setRows(
      list.length
        ? list.map((p) => ({
            key: nextKey(),
            account_id: p.account_id ?? '',
            symbol: p.assets?.symbol ?? '',
            kind: (p.assets?.kind ?? 'diger') as AssetKind,
            quantity: p.quantity != null ? String(p.quantity) : '',
            unit_price: p.unit_price != null ? String(p.unit_price) : '',
            amount: String(p.amount),
            currency: p.currency,
            fx_rate: String(p.fx_rate ?? 1),
            note: p.note ?? '',
          }))
        : [emptyRow()]
    )
    const { data: liab } = await supabase.from('liabilities').select('*').eq('snapshot_id', snap.id)
    setDebts(
      ((liab ?? []) as Liability[]).map((l) => ({
        key: nextKey(),
        title: l.title,
        type: l.type,
        counterparty: l.counterparty ?? '',
        amount: String(l.amount),
        currency: l.currency,
        fx_rate: String(l.fx_rate ?? 1),
      }))
    )
    setInfo(`${snap.snapshot_date} tarihli kayıttan ${list.length} kalem kopyalandı.`)
  }

  /**
   * Güncel fiyatları çeker ve adet girilmiş satırların tutarını
   * adet × birim fiyat olarak doldurur. Döviz satırlarında kur da tazelenir.
   */
  const fillFromPrices = async () => {
    setError(null)
    setInfo(null)

    // Yeni yazılan sembol henüz katalogda olmayabilir; fiyat çekici yalnızca
    // kayıtlı varlıklara baktığı için önce onları oluştur.
    if (user) {
      const seen = new Set<string>()
      for (const r of rows) {
        const sym = r.symbol.trim().toUpperCase()
        if (!sym || seen.has(sym)) continue
        seen.add(sym)
        try {
          await ensureAsset(sym, r.kind, user.id)
        } catch {
          // katalog hatası fiyat çekmeyi durdurmasın
        }
      }
    }

    const res = await refresh()
    if (!res) {
      setError('Fiyatlar çekilemedi. Edge Function kurulu mu?')
      return
    }
    const { summary, data } = res

    let filledCount = 0
    const missing: string[] = []

    setRows((prev) =>
      prev.map((r) => {
        // Kur her satırda tazelenir (adet girilmemiş döviz kalemleri için de gerekli)
        const fxRate =
          r.currency === 'TRY' ? '1' : data.fx[r.currency] ? String(data.fx[r.currency]) : r.fx_rate

        const sym = r.symbol.trim().toUpperCase()
        if (!sym) return { ...r, fx_rate: fxRate }

        const price = data.bySymbol.get(sym)
        const qty = parseAmount(r.quantity)
        if (!price) {
          if (qty > 0) missing.push(sym)
          return { ...r, fx_rate: fxRate }
        }
        if (qty <= 0) return { ...r, fx_rate: fxRate }

        // Fiyatlar TRY cinsinden tutulur; satır başka para birimindeyse çevir
        const rate = parseAmount(fxRate) || 1
        const unit = price.price / rate
        filledCount++
        return {
          ...r,
          fx_rate: fxRate,
          unit_price: String(unit),
          amount: String(qty * unit),
        }
      })
    )

    const hasInput = rows.some((r) => r.symbol.trim() && parseAmount(r.quantity) > 0)
    const parts = hasInput
      ? [`${filledCount} kalem güncellendi`]
      : ['Kurlar tazelendi. Tutar hesaplanması için satıra varlık kodu ve adet gir (örn. THYAO · 100).']
    if (missing.length) parts.push(`fiyatı bulunamayan: ${[...new Set(missing)].join(', ')}`)
    if (summary?.errors?.length) parts.push(summary.errors.join(' · '))
    setInfo(parts.join(' · '))
  }

  const save = async () => {
    if (!user) return
    setSaving(true)
    setError(null)
    setInfo(null)
    try {
      const filled = rows.filter((r) => r.symbol.trim() || parseAmount(r.amount) !== 0)
      if (!filled.length) throw new Error('En az bir kalem gir.')

      // 1) Snapshot (aynı tarih varsa güncelle)
      const { data: snap, error: snapErr } = await supabase
        .from('snapshots')
        .upsert(
          { id: editId, user_id: user.id, snapshot_date: date, note: note || null },
          { onConflict: 'user_id,snapshot_date' }
        )
        .select()
        .single()
      if (snapErr) throw new Error(snapErr.message)
      const snapshotId = snap.id as string

      // 2) Varlık kataloğunu tamamla
      const symbolToAssetId = new Map<string, string>()
      for (const r of filled) {
        const sym = r.symbol.trim().toUpperCase()
        if (!sym || symbolToAssetId.has(sym)) continue
        const asset = await ensureAsset(sym, r.kind, user.id)
        if (asset) symbolToAssetId.set(sym, asset.id)
      }

      // 3) Kalemleri yaz (mevcutları sil, yeniden ekle)
      await supabase.from('positions').delete().eq('snapshot_id', snapshotId)
      const payload = filled.map((r) => ({
        snapshot_id: snapshotId,
        user_id: user.id,
        account_id: r.account_id || null,
        asset_id: symbolToAssetId.get(r.symbol.trim().toUpperCase()) ?? null,
        quantity: r.quantity ? parseAmount(r.quantity) : null,
        unit_price: r.unit_price ? parseAmount(r.unit_price) : null,
        amount: parseAmount(r.amount),
        currency: r.currency,
        fx_rate: parseAmount(r.fx_rate) || 1,
        note: r.note || null,
      }))
      const { error: posErr } = await supabase.from('positions').insert(payload)
      if (posErr) throw new Error(posErr.message)

      // 4) Borçlar
      await supabase.from('liabilities').delete().eq('snapshot_id', snapshotId)
      const debtPayload = debts
        .filter((d) => d.title.trim() || parseAmount(d.amount) !== 0)
        .map((d) => ({
          user_id: user.id,
          snapshot_id: snapshotId,
          title: d.title.trim() || 'Borç',
          type: d.type,
          counterparty: d.counterparty || null,
          amount: parseAmount(d.amount),
          currency: d.currency,
          fx_rate: parseAmount(d.fx_rate) || 1,
        }))
      if (debtPayload.length) {
        const { error: debtErr } = await supabase.from('liabilities').insert(debtPayload)
        if (debtErr) throw new Error(debtErr.message)
      }

      navigate('/history')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />

  return (
    <div className="space-y-5">
      <PageHeader
        title={editId ? 'Kaydı Düzenle' : 'Yeni Giriş'}
        subtitle={
          latestDate
            ? `Kalem kalem gir, altta canlı toplamı gör. Fiyatlar ${latestDate} tarihli.`
            : 'Kalem kalem varlıklarını gir, altta canlı toplamı gör.'
        }
        actions={
          <>
            <button className="btn-ghost" onClick={copyFromLast} type="button">
              Son kayıttan kopyala
            </button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </>
        }
      />

      {error && <ErrorBox message={error} />}
      {info && (
        <div className="rounded-lg border border-accent/40 bg-accent/10 text-accent px-3 py-2 text-sm">
          {info}
        </div>
      )}

      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Tarih</label>
            <input type="date" className="w-full" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Not</label>
            <input
              className="w-full"
              placeholder="Örn. ay sonu kapanış"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
      </Card>

      <datalist id="asset-symbols">
        {assets.map((a) => (
          <option key={a.id} value={a.symbol}>
            {a.name ?? ''}
          </option>
        ))}
      </datalist>

      <Card
        title="Varlık Kalemleri"
        actions={
          <>
            <button
              className="btn-ghost text-xs"
              onClick={fillFromPrices}
              disabled={refreshing}
              type="button"
              title="TCMB, TEFAS, Yahoo, CoinGecko ve altın fiyatlarını çeker"
            >
              {refreshing ? 'Fiyatlar çekiliyor…' : '↻ Güncel fiyatları çek'}
            </button>
            <button className="btn-ghost text-xs" onClick={() => setRows((p) => [...p, emptyRow()])}>
              + Satır ekle
            </button>
          </>
        }
      >
        {accounts.length === 0 && (
          <p className="mb-3 text-xs text-amber-400">
            Henüz hesap tanımlamadın. Hesaplar sayfasından banka/kurum ekleyebilirsin.
          </p>
        )}

        <div className="space-y-2">
          {rows.map((r) => {
            const rowTRY = parseAmount(r.amount) * (parseAmount(r.fx_rate) || 1)
            const livePrice = bySymbol.get(r.symbol.trim().toUpperCase())
            return (
              <div
                key={r.key}
                className="grid gap-2 rounded-lg border border-border bg-surface2/40 p-2 md:grid-cols-[1.2fr_1fr_.8fr_.7fr_1fr_.7fr_.8fr_1fr_auto] md:items-end md:border-0 md:bg-transparent md:p-0"
              >
                <div>
                  <label className="label md:sr-only">Hesap</label>
                  <select
                    className="w-full"
                    value={r.account_id}
                    onChange={(e) => setRow(r.key, { account_id: e.target.value })}
                  >
                    <option value="">Hesap seç…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label md:sr-only">Varlık</label>
                  <input
                    list="asset-symbols"
                    className="w-full uppercase"
                    placeholder="THYAO"
                    value={r.symbol}
                    onChange={(e) => {
                      const sym = e.target.value
                      const known = assets.find((a) => a.symbol.toUpperCase() === sym.trim().toUpperCase())
                      setRow(r.key, { symbol: sym, ...(known ? { kind: known.kind } : {}) })
                    }}
                  />
                  {livePrice && (
                    <p className="mt-0.5 text-[10px] text-muted" title={`Kaynak: ${livePrice.source ?? '—'}`}>
                      {formatNumber(livePrice.price, 4)} ₺ · {livePrice.date.slice(5).replace('-', '.')}
                    </p>
                  )}
                </div>
                <div>
                  <label className="label md:sr-only">Tür</label>
                  <select
                    className="w-full"
                    value={r.kind}
                    onChange={(e) => setRow(r.key, { kind: e.target.value as AssetKind })}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label md:sr-only">Adet</label>
                  <input
                    className="w-full num"
                    inputMode="decimal"
                    placeholder="Adet"
                    value={r.quantity}
                    onChange={(e) => setRow(r.key, { quantity: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label md:sr-only">Tutar</label>
                  <input
                    className="w-full num"
                    inputMode="decimal"
                    placeholder="Tutar"
                    value={r.amount}
                    onChange={(e) => setRow(r.key, { amount: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label md:sr-only">Kur cinsi</label>
                  <select
                    className="w-full"
                    value={r.currency}
                    onChange={(e) => {
                      const currency = e.target.value as Currency
                      setRow(r.key, { currency, ...(currency === 'TRY' ? { fx_rate: '1' } : {}) })
                    }}
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label md:sr-only">Kur</label>
                  <input
                    className="w-full num"
                    inputMode="decimal"
                    placeholder="Kur"
                    disabled={r.currency === 'TRY'}
                    value={r.fx_rate}
                    onChange={(e) => setRow(r.key, { fx_rate: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label md:sr-only">Not</label>
                  <input
                    className="w-full"
                    placeholder="Not"
                    value={r.note}
                    onChange={(e) => setRow(r.key, { note: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2 justify-between md:justify-end">
                  <span className="num text-xs text-muted md:hidden">{formatTRY(rowTRY)}</span>
                  <button
                    type="button"
                    className="btn-danger px-2 py-2"
                    onClick={() => setRows((p) => (p.length > 1 ? p.filter((x) => x.key !== r.key) : p))}
                    aria-label="Satırı sil"
                  >
                    ×
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm text-muted">Toplam varlık</span>
          <span className="num text-lg font-semibold">{formatTRY(totalTRY)}</span>
        </div>
      </Card>

      <Card
        title="Borçlar (bu tarihteki bakiyeler)"
        actions={
          <button className="btn-ghost text-xs" onClick={() => setDebts((p) => [...p, emptyDebt()])}>
            + Borç ekle
          </button>
        }
      >
        {debts.length === 0 ? (
          <p className="text-sm text-muted">Kredi kartı / kredi bakiyesi eklemek istersen yukarıdan ekle.</p>
        ) : (
          <div className="space-y-2">
            {debts.map((d) => (
              <div
                key={d.key}
                className="grid gap-2 rounded-lg border border-border bg-surface2/40 p-2 md:grid-cols-[1.4fr_1fr_1fr_1fr_.7fr_.7fr_auto] md:items-end md:border-0 md:bg-transparent md:p-0"
              >
                <input
                  className="w-full"
                  placeholder="Başlık — Garanti Kredi Kartı"
                  value={d.title}
                  onChange={(e) => setDebt(d.key, { title: e.target.value })}
                />
                <select
                  className="w-full"
                  value={d.type}
                  onChange={(e) => setDebt(d.key, { type: e.target.value as LiabilityType })}
                >
                  {DEBT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <input
                  className="w-full"
                  placeholder="Kime"
                  value={d.counterparty}
                  onChange={(e) => setDebt(d.key, { counterparty: e.target.value })}
                />
                <input
                  className="w-full num"
                  inputMode="decimal"
                  placeholder="Tutar"
                  value={d.amount}
                  onChange={(e) => setDebt(d.key, { amount: e.target.value })}
                />
                <select
                  className="w-full"
                  value={d.currency}
                  onChange={(e) => {
                    const currency = e.target.value as Currency
                    setDebt(d.key, { currency, ...(currency === 'TRY' ? { fx_rate: '1' } : {}) })
                  }}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  className="w-full num"
                  inputMode="decimal"
                  placeholder="Kur"
                  disabled={d.currency === 'TRY'}
                  value={d.fx_rate}
                  onChange={(e) => setDebt(d.key, { fx_rate: e.target.value })}
                />
                <button
                  type="button"
                  className="btn-danger px-2 py-2"
                  onClick={() => setDebts((p) => p.filter((x) => x.key !== d.key))}
                  aria-label="Borcu sil"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="mt-2 flex items-center justify-between border-t border-border pt-3">
              <span className="text-sm text-muted">Toplam borç</span>
              <span className="num text-lg font-semibold text-neg">{formatTRY(totalDebtTRY)}</span>
            </div>
          </div>
        )}
      </Card>

      <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4">
          <div className="text-sm text-muted">Net değer</div>
          <div className="num text-lg font-semibold">{formatTRY(totalTRY - totalDebtTRY)}</div>
          <button className="btn-primary ml-auto" onClick={save} disabled={saving}>
            {saving ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>
  )
}
