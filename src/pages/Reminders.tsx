import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { useTable } from '../hooks/useTable'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { todayISO } from '../lib/calc'
import type { Reminder, ReminderChannel, RepeatMode } from '../types/db'

const REPEATS: { value: RepeatMode; label: string; hint: string }[] = [
  { value: 'once', label: 'Tek seferlik', hint: 'Seçtiğin tarihte bir kez gönderilir, sonra kapanır.' },
  { value: 'monthly', label: 'Her ay', hint: 'Her ayın aynı gününde tekrarlanır.' },
]

const CHANNELS: { value: ReminderChannel; label: string }[] = [
  { value: 'wa', label: 'WhatsApp' },
  { value: 'mail', label: 'E-posta' },
  { value: 'both', label: 'WhatsApp + e-posta' },
]

const channelLabel = (c: ReminderChannel | null) =>
  CHANNELS.find((x) => x.value === (c ?? 'wa'))?.label ?? 'WhatsApp'

const fmt = (iso: string) => format(parseISO(iso), 'd MMMM yyyy', { locale: tr })

export default function RemindersPage() {
  const { user } = useAuth()
  const { rows, loading, error, insert, update, remove } = useTable<Reminder>('reminders', {
    userId: user?.id,
    orderBy: 'next_date',
    ascending: true,
  })

  const [modal, setModal] = useState<Reminder | 'new' | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  const editing = modal && modal !== 'new' ? modal : null
  const today = todayISO()

  const { active, done } = useMemo(
    () => ({
      active: rows.filter((r) => r.is_active),
      done: rows.filter((r) => !r.is_active),
    }),
    [rows]
  )

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!user) return
    const fd = new FormData(e.currentTarget)
    const title = String(fd.get('title') ?? '').trim()
    if (!title) {
      setFormError('Başlık gerekli — mesajın konusu bu olacak.')
      return
    }
    const values = {
      title,
      body: String(fd.get('body') ?? '').trim() || null,
      next_date: String(fd.get('next_date') ?? today),
      send_time: String(fd.get('send_time') ?? '09:00'),
      repeat_mode: String(fd.get('repeat_mode') ?? 'once') as RepeatMode,
      channel: String(fd.get('channel') ?? 'wa') as ReminderChannel,
      is_active: true,
    }
    setBusy(true)
    setFormError(null)
    try {
      if (editing) await update(editing.id, values)
      else await insert({ ...values, user_id: user.id })
      setModal(null)
    } catch (ex) {
      setFormError(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  /** Hatırlatmayı beklemeden şimdi gönderir — kurulumu denemek için. */
  const sendNow = async () => {
    setInfo(null)
    setBusy(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('custom-reminders', { body: {} })
      if (fnErr) throw new Error(fnErr.message)
      const res = data as { sent: number; errors?: string[] }
      // Kanal başına kısmi başarı mümkün (WhatsApp gitti, mail gitmedi gibi);
      // gönderilenle hatalar birlikte gösterilsin.
      const parts: string[] = []
      if (res.sent > 0) parts.push(`${res.sent} hatırlatma gönderildi.`)
      if (res.errors?.length) parts.push(...res.errors)
      setInfo(parts.length ? parts.join(' · ') : 'Tarihi ve saati gelmiş hatırlatma yok.')
    } catch (ex) {
      setInfo(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <Spinner />

  const list = (items: Reminder[], muted: boolean) => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">Başlık</th>
            <th className="th">Açıklama</th>
            <th className="th">Tarih & saat</th>
            <th className="th">Tekrar</th>
            <th className="th">Kanal</th>
            <th className="th"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const overdue = r.is_active && r.next_date < today
            return (
              <tr key={r.id} className={muted ? 'opacity-60' : ''}>
                <td className="td font-medium">{r.title}</td>
                <td className="td text-muted text-xs max-w-xs truncate" title={r.body ?? ''}>
                  {r.body || '—'}
                </td>
                <td className="td whitespace-nowrap">
                  {fmt(r.next_date)}
                  <span className="text-muted"> · {(r.send_time ?? '09:00').slice(0, 5)}</span>
                  {overdue && <span className="ml-2 text-xs text-neg">gecikti</span>}
                </td>
                <td className="td">
                  <Badge tone={r.repeat_mode === 'monthly' ? 'accent' : 'muted'}>
                    {r.repeat_mode === 'monthly' ? 'Her ay' : 'Tek seferlik'}
                  </Badge>
                </td>
                <td className="td whitespace-nowrap">
                  <Badge tone={r.channel === 'both' ? 'pos' : 'muted'}>{channelLabel(r.channel)}</Badge>
                </td>
                <td className="td text-right whitespace-nowrap">
                  <button className="btn-ghost text-xs" onClick={() => { setFormError(null); setModal(r) }}>
                    Düzenle
                  </button>{' '}
                  {!r.is_active && (
                    <button
                      className="btn-ghost text-xs"
                      onClick={() => void update(r.id, { is_active: true })}
                    >
                      Tekrar aç
                    </button>
                  )}{' '}
                  <button
                    className="btn-danger text-xs"
                    onClick={() => {
                      if (confirm(`"${r.title}" silinsin mi?`)) void remove(r.id)
                    }}
                  >
                    Sil
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hatırlatıcılar"
        subtitle="Tarihi gelince seçtiğin kanaldan gelir: WhatsApp, e-posta ya da ikisi birden. Başlık mesajın konusu, açıklama içeriği olur."
        actions={
          <>
            <button className="btn-ghost" onClick={sendNow} disabled={busy}>
              {busy ? 'Gönderiliyor…' : 'Şimdi gönder'}
            </button>
            <button className="btn-primary" onClick={() => { setFormError(null); setModal('new') }}>
              + Hatırlatıcı Ekle
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

      <Card title={`Aktif (${active.length})`}>
        {active.length ? list(active, false) : <Empty>Aktif hatırlatıcı yok.</Empty>}
      </Card>

      {done.length > 0 && <Card title={`Tamamlanan (${done.length})`}>{list(done, true)}</Card>}

      <Modal
        open={modal !== null}
        title={editing ? 'Hatırlatıcıyı Düzenle' : 'Yeni Hatırlatıcı'}
        onClose={() => setModal(null)}
      >
        <form onSubmit={submit} className="space-y-3">
          {formError && <ErrorBox message={formError} />}
          <div>
            <label className="label">Başlık — mesajın konusu</label>
            <input
              name="title"
              className="w-full"
              placeholder="Örn. Kira ödemesi"
              defaultValue={editing?.title ?? ''}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Açıklama — mesajın içeriği</label>
            <textarea
              name="body"
              className="w-full min-h-[90px]"
              placeholder="Örn. Ev sahibine 25.000 TL gönder, dekontu ilet."
              defaultValue={editing?.body ?? ''}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Tarih</label>
              <input
                type="date"
                name="next_date"
                className="w-full"
                defaultValue={editing?.next_date ?? today}
              />
            </div>
            <div>
              <label className="label">Saat</label>
              <input
                type="time"
                name="send_time"
                className="w-full"
                defaultValue={(editing?.send_time ?? '09:00').slice(0, 5)}
              />
            </div>
            <div>
              <label className="label">Tekrar</label>
              <select name="repeat_mode" className="w-full" defaultValue={editing?.repeat_mode ?? 'once'}>
                {REPEATS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Nereden gelsin</label>
            <select name="channel" className="w-full" defaultValue={editing?.channel ?? 'wa'}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted">
            Tek seferlik hatırlatma gönderildikten sonra kapanır; her ay seçilirse bir sonraki
            ayın aynı gününe taşınır. Ayın 31'i gibi her ayda olmayan günler ay sonuna kırpılır.
            Mesaj, seçtiğin saatten sonraki ilk kontrolde gider — en fazla 5 dakika gecikmeyle.
            WhatsApp seçiliyken mesaj gidemezse hatırlatma kaybolmasın diye e-postaya düşülür.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setModal(null)}>Vazgeç</button>
            <button className="btn-primary" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Kaydet'}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
