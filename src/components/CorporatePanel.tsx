import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { supabase } from '../lib/supabase'
import { useAssets } from '../hooks/useAssets'
import { Badge, Card, Empty, ErrorBox, Modal } from './ui'
import { formatNumber, formatTRY, parseAmount } from '../lib/currency'
import { todayISO } from '../lib/calc'
import type { ActionRow, DividendRow } from '../hooks/useCorporate'
import type { Account, AssetKind } from '../types/db'

/**
 * Bedelsiz / bölünme ve temettü kayıtları.
 *
 * Bedelsiz olmadan portföy sessizce yanlış çıkıyor: %100 bedelsiz veren
 * kâğıtta eldeki adet ikiye katlanır ama alım satım defteri bunu bilmez,
 * uygulama %50 zarar gösterir. Temettü de fiyat farkına girmediği için
 * kaydedilmezse getiri eksik görünür.
 */

const KIND_LABEL: Record<ActionRow['kind'], string> = {
  bedelsiz: 'Bedelsiz',
  bolunme: 'Bölünme',
  birlesme: 'Birleşme',
}

/** Yüzde girdisini adet çarpanına çevirir: %100 → 2 */
const pctToRatio = (pct: number) => 1 + pct / 100
const ratioToPct = (ratio: number) => (ratio - 1) * 100

interface Props {
  userId: string
  /** Düzenlemeye izin var mı — başkasının sekmesinde salt okunur */
  editable: boolean
  accounts: Account[]
  actions: ActionRow[]
  dividends: DividendRow[]
  onChanged: () => void
}

export default function CorporatePanel({
  userId, editable, accounts, actions, dividends, onChanged,
}: Props) {
  const { ensureAsset } = useAssets()
  const [modal, setModal] = useState<'action' | 'dividend' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionKind, setActionKind] = useState<ActionRow['kind']>('bedelsiz')

  const divTotals = useMemo(() => {
    let gross = 0
    let tax = 0
    for (const d of dividends) {
      gross += Number(d.gross_amount)
      tax += Number(d.tax_amount)
    }
    return { gross, tax, net: gross - tax }
  }, [dividends])

  const close = () => {
    setModal(null)
    setFormError(null)
  }

  const submitAction = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const symbol = String(fd.get('symbol') ?? '').trim().toUpperCase()
    const action_date = String(fd.get('action_date') ?? '')
    if (!symbol) return setFormError('Sembol gerekli.')
    if (!action_date) return setFormError('Tarih gerekli.')

    // Bedelsizde yüzde, bölünme/birleşmede doğrudan çarpan istenir
    const ratio =
      actionKind === 'bedelsiz'
        ? pctToRatio(parseAmount(String(fd.get('pct') ?? '')))
        : parseAmount(String(fd.get('ratio') ?? ''))
    if (!(ratio > 0)) return setFormError('Oran sıfırdan büyük olmalı.')
    if (actionKind === 'bedelsiz' && ratio === 1) return setFormError('Bedelsiz oranı 0 olamaz.')

    setSaving(true)
    setFormError(null)
    try {
      const asset = await ensureAsset(symbol, String(fd.get('kind') ?? 'hisse') as AssetKind)
      if (!asset) throw new Error('Sembol kaydedilemedi.')
      const { error } = await supabase.from('corporate_actions').insert({
        user_id: userId,
        asset_id: asset.id,
        action_date,
        kind: actionKind,
        ratio,
        note: String(fd.get('note') ?? '').trim() || null,
      })
      if (error) throw new Error(error.message)
      onChanged()
      close()
    } catch (ex) {
      setFormError(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setSaving(false)
    }
  }

  const submitDividend = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const symbol = String(fd.get('symbol') ?? '').trim().toUpperCase()
    const pay_date = String(fd.get('pay_date') ?? '')
    const gross = parseAmount(String(fd.get('gross_amount') ?? ''))
    if (!symbol) return setFormError('Sembol gerekli.')
    if (!pay_date) return setFormError('Ödeme tarihi gerekli.')
    if (!(gross > 0)) return setFormError('Brüt tutar sıfırdan büyük olmalı.')

    const tax = parseAmount(String(fd.get('tax_amount') ?? ''))
    if (tax > gross) return setFormError('Stopaj brüt tutardan büyük olamaz.')
    const accountId = String(fd.get('account_id') ?? '') || null

    setSaving(true)
    setFormError(null)
    try {
      const asset = await ensureAsset(symbol, 'hisse')
      if (!asset) throw new Error('Sembol kaydedilemedi.')
      const { data, error } = await supabase
        .from('dividends')
        .insert({
          user_id: userId,
          asset_id: asset.id,
          account_id: accountId,
          pay_date,
          quantity: parseAmount(String(fd.get('quantity') ?? '')) || null,
          gross_per_share: parseAmount(String(fd.get('gross_per_share') ?? '')) || null,
          gross_amount: gross,
          tax_amount: tax,
          note: String(fd.get('note') ?? '').trim() || null,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)

      // Hesap seçildiyse para nakit defterine de girsin — net tutar
      if (accountId) {
        const { error: ledErr } = await supabase.from('account_ledger').insert({
          user_id: userId,
          account_id: accountId,
          dividend_id: data.id,
          kind: 'temettu',
          amount: gross - tax,
          date: pay_date,
          note: `${symbol} temettü`,
        })
        if (ledErr) {
          throw new Error(
            `Temettü kaydedildi ama nakit hareketi yazılamadı — supabase/borsa-ek.sql çalıştırıldı mı? (${ledErr.message})`
          )
        }
      }
      onChanged()
      close()
    } catch (ex) {
      setFormError(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setSaving(false)
    }
  }

  const removeAction = async (row: ActionRow) => {
    if (!confirm(`${row.symbol} ${KIND_LABEL[row.kind]} kaydı silinsin mi?`)) return
    await supabase.from('corporate_actions').delete().eq('id', row.id)
    onChanged()
  }

  const removeDividend = async (row: DividendRow) => {
    if (!confirm(`${row.symbol} temettüsü silinsin mi?`)) return
    // Nakit hareketi dividend_id üzerinden cascade ile birlikte gider
    await supabase.from('dividends').delete().eq('id', row.id)
    onChanged()
  }

  const fmtDate = (iso: string) => format(parseISO(iso), 'd MMM yyyy', { locale: tr })

  return (
    <div className="grid gap-4 lg:grid-cols-2 items-start">
      {/* --------------------------------------------- bedelsiz / bölünme */}
      <Card
        title="Bedelsiz & Bölünme"
        actions={
          editable && (
            <button
              className="btn-ghost text-xs"
              onClick={() => {
                setActionKind('bedelsiz')
                setFormError(null)
                setModal('action')
              }}
            >
              + Ekle
            </button>
          )
        }
      >
        {!actions.length ? (
          <Empty>
            Kayıt yok. Portföyündeki bir kâğıt bedelsiz verdiyse buraya gir — yoksa adet eski
            haliyle kalır ve pozisyon zararda görünür.
          </Empty>
        ) : (
          <div className="space-y-1.5">
            {actions.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{a.symbol}</span>
                  <span className="ml-2"><Badge tone="accent">{KIND_LABEL[a.kind]}</Badge></span>
                  <span className="text-muted text-xs ml-2">{fmtDate(a.action_date)}</span>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="num text-xs text-muted">
                    {a.kind === 'bedelsiz'
                      ? `%${formatNumber(ratioToPct(a.ratio), 0)}`
                      : `×${formatNumber(a.ratio, 2)}`}
                  </span>
                  {editable && (
                    <button className="btn-danger text-xs" onClick={() => void removeAction(a)}>
                      Sil
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------- temettü */}
      <Card
        title="Temettü"
        actions={
          <div className="flex items-center gap-3">
            {dividends.length > 0 && (
              <span className="text-xs text-muted">Net {formatTRY(divTotals.net)}</span>
            )}
            {editable && (
              <button
                className="btn-ghost text-xs"
                onClick={() => {
                  setFormError(null)
                  setModal('dividend')
                }}
              >
                + Ekle
              </button>
            )}
          </div>
        }
      >
        {!dividends.length ? (
          <Empty>
            Kayıt yok. Temettü fiyat farkına girmez; girilmezse hissenin gerçek getirisi olduğundan
            düşük görünür.
          </Empty>
        ) : (
          <div className="space-y-1.5">
            {dividends.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{d.symbol}</span>
                  <span className="text-muted text-xs ml-2">{fmtDate(d.pay_date)}</span>
                  {d.account_name && (
                    <span className="text-muted text-xs ml-2">· {d.account_name}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="num text-xs">
                    <span className="text-pos">{formatTRY(Number(d.gross_amount) - Number(d.tax_amount))}</span>
                    {Number(d.tax_amount) > 0 && (
                      <span className="text-muted"> (stopaj {formatTRY(d.tax_amount)})</span>
                    )}
                  </span>
                  {editable && (
                    <button className="btn-danger text-xs" onClick={() => void removeDividend(d)}>
                      Sil
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- form */}
      <Modal
        open={modal === 'action'}
        title="Bedelsiz / Bölünme"
        onClose={close}
      >
        <form onSubmit={submitAction} className="space-y-3">
          {formError && <ErrorBox message={formError} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Sembol</label>
              <input name="symbol" className="w-full" placeholder="THYAO" autoFocus />
            </div>
            <div>
              <label className="label">Tür</label>
              <select
                className="w-full"
                value={actionKind}
                onChange={(e) => setActionKind(e.target.value as ActionRow['kind'])}
              >
                <option value="bedelsiz">Bedelsiz sermaye artırımı</option>
                <option value="bolunme">Bölünme (lot artışı)</option>
                <option value="birlesme">Birleşme (lot azalışı)</option>
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Tarih</label>
              <input type="date" name="action_date" className="w-full" defaultValue={todayISO()} />
            </div>
            {actionKind === 'bedelsiz' ? (
              <div>
                <label className="label">Bedelsiz oranı (%)</label>
                <input name="pct" className="w-full" placeholder="100" />
              </div>
            ) : (
              <div>
                <label className="label">Adet çarpanı</label>
                <input
                  name="ratio"
                  className="w-full"
                  placeholder={actionKind === 'bolunme' ? '5' : '0,2'}
                />
              </div>
            )}
          </div>
          <input type="hidden" name="kind" value="hisse" />
          <div>
            <label className="label">Not</label>
            <input name="note" className="w-full" placeholder="KAP bildirimi 12.08.2026" />
          </div>
          <p className="text-xs text-muted">
            Oran, işlem tarihinden önce elde olan adede uygulanır; toplam maliyet değişmez, birim
            maliyet kendiliğinden düşer. %100 bedelsiz 100 lotu 200 lota çıkarır. Bölünmede
            1 lot 5 lot olacaksa çarpan 5, 5 lot 1 lota inecekse 0,2.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={close}>Vazgeç</button>
            <button className="btn-primary" disabled={saving}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
          </div>
        </form>
      </Modal>

      <Modal open={modal === 'dividend'} title="Temettü ekle" onClose={close}>
        <form onSubmit={submitDividend} className="space-y-3">
          {formError && <ErrorBox message={formError} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Sembol</label>
              <input name="symbol" className="w-full" placeholder="EREGL" autoFocus />
            </div>
            <div>
              <label className="label">Ödeme tarihi</label>
              <input type="date" name="pay_date" className="w-full" defaultValue={todayISO()} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Brüt tutar</label>
              <input name="gross_amount" className="w-full" placeholder="4.250" />
            </div>
            <div>
              <label className="label">Stopaj</label>
              <input name="tax_amount" className="w-full" placeholder="425" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Lot (isteğe bağlı)</label>
              <input name="quantity" className="w-full" placeholder="1.500" />
            </div>
            <div>
              <label className="label">Lot başına brüt (isteğe bağlı)</label>
              <input name="gross_per_share" className="w-full" placeholder="2,8333" />
            </div>
          </div>
          <div>
            <label className="label">Hesap</label>
            <select name="account_id" className="w-full" defaultValue="">
              <option value="">Nakit defterine işleme</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Not</label>
            <input name="note" className="w-full" />
          </div>
          <p className="text-xs text-muted">
            Hesap seçersen net tutar o hesabın nakit defterine "temettü" olarak girer. Brüt ve
            stopaj ayrı tutulur; yıl sonu beyanında ikisi de gerekiyor.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={close}>Vazgeç</button>
            <button className="btn-primary" disabled={saving}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
