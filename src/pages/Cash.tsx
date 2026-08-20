import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { tr } from 'date-fns/locale'
import { useAuth } from '../hooks/useAuth'
import { useCash, type CashAccount } from '../hooks/useCash'
import NumberInput from '../components/NumberInput'
import StatCard from '../components/StatCard'
import { Badge, Card, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { formatTRY, parseTRInput, toTRInput } from '../lib/currency'
import { todayISO } from '../lib/calc'
import { LEDGER_LABELS, LEDGER_TONES } from '../lib/cash'
import { DEFAULT_NEMA_RATE, formatRate, projectNema } from '../lib/nema'
import type { Account, LedgerKind } from '../types/db'

/**
 * Sık kullanılan hesaplar — yoksa tek tıkla açılır. `key` mevcut hesabın
 * adında aranır ki "Garanti Bankası" varken "Garanti BBVA" ikinci kez
 * eklenmesin.
 */
const PRESETS: { key: string; name: string; type: Account['type']; nema_rate?: number }[] = [
  { key: 'akbank', name: 'Akbank', type: 'banka' },
  { key: 'garanti', name: 'Garanti BBVA', type: 'banka' },
  { key: 'fiba', name: 'Fibabanka', type: 'banka' },
  { key: 'midas', name: 'Midas', type: 'aracikurum', nema_rate: DEFAULT_NEMA_RATE },
]

type ModalState =
  | { type: 'move'; kind: 'giris' | 'cikis'; accountId: string }
  | { type: 'transfer'; from: string }
  | { type: 'nema'; account: CashAccount }
  | null

type KindFilter = 'gunluk' | 'nema' | 'tumu'

export default function Cash() {
  const { user } = useAuth()
  const {
    accounts, ledger, totals, canWrite, loading, error,
    deposit, withdraw, transfer, removeMove, setNemaRate, recalcNema, ensureAccounts,
  } = useCash(user?.id)

  const [modal, setModal] = useState<ModalState>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Form alanları — modal açılırken sıfırlanır
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayISO())
  const [note, setNote] = useState('')
  const [target, setTarget] = useState('')
  const [rate, setRate] = useState('')
  const [nemaStart, setNemaStart] = useState('')

  const [filterAccount, setFilterAccount] = useState('')
  const [filterKind, setFilterKind] = useState<KindFilter>('gunluk')
  const [showAll, setShowAll] = useState(false)

  const activeAccounts = useMemo(() => accounts.filter((a) => a.is_active), [accounts])
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—'

  const missingPresets = useMemo(
    () =>
      PRESETS.filter(
        (p) => !accounts.some((a) => a.name.toLocaleLowerCase('tr').includes(p.key))
      ),
    [accounts]
  )

  /** Bugünkü bakiyeler aynı oranla dursa ay sonunda ne kazandırır */
  const monthlyEstimate = useMemo(
    () =>
      accounts.reduce(
        (s, a) => s + projectNema(a.balance, Number(a.nema_rate ?? 0), 30),
        0
      ),
    [accounts]
  )

  const moves = useMemo(() => {
    let rows = ledger
    if (filterAccount) rows = rows.filter((l) => l.account_id === filterAccount)
    if (filterKind === 'nema') rows = rows.filter((l) => l.kind === 'nema')
    else if (filterKind === 'gunluk') rows = rows.filter((l) => l.kind !== 'nema')
    return rows
  }, [ledger, filterAccount, filterKind])

  const visibleMoves = showAll ? moves : moves.slice(0, 40)

  // ---------------------------------------------------------------- modal
  const openMove = (kind: 'giris' | 'cikis', accountId: string) => {
    setFormError(null)
    setAmount('')
    setDate(todayISO())
    setNote('')
    setModal({ type: 'move', kind, accountId })
  }

  const openTransfer = (from: string) => {
    setFormError(null)
    setAmount('')
    setDate(todayISO())
    setNote('')
    setTarget('')
    setModal({ type: 'transfer', from })
  }

  const openNema = (account: CashAccount) => {
    setFormError(null)
    setRate(toTRInput(Number(account.nema_rate) || DEFAULT_NEMA_RATE))
    setNemaStart(account.nema_start ?? '')
    setModal({ type: 'nema', account })
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

  const submitMove = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'move') return
    const value = parseTRInput(amount)
    void guard(() =>
      modal.kind === 'giris'
        ? deposit(modal.accountId, value, date, note)
        : withdraw(modal.accountId, value, date, note)
    )
  }

  const submitTransfer = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'transfer') return
    void guard(() => transfer(modal.from, target, parseTRInput(amount), date, note))
  }

  const submitNema = (e: React.FormEvent) => {
    e.preventDefault()
    if (modal?.type !== 'nema') return
    void guard(() => setNemaRate(modal.account.id, parseTRInput(rate), nemaStart || null))
  }

  const del = async (id: string) => {
    const row = ledger.find((l) => l.id === id)
    if (!row) return
    const extra = row.transfer_id ? ' Aktarımın karşı bacağı da silinir.' : ''
    if (!confirm(`Hareket silinsin mi?${extra}`)) return
    try {
      await removeMove(row)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) return <Spinner />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Nakit"
        subtitle="Hesaplardaki para, giriş / çıkış hareketleri ve günlük nemalandırma"
        actions={
          canWrite &&
          activeAccounts.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => openTransfer(activeAccounts[0].id)}>
                Aktar
              </button>
              <button className="btn-primary" onClick={() => openMove('giris', activeAccounts[0].id)}>
                + Para girişi
              </button>
            </>
          )
        }
      />

      {error && <ErrorBox message={error} />}
      {formError && !modal && <ErrorBox message={formError} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Toplam Nakit"
          value={totals.cash}
          hint={`${activeAccounts.length} hesap`}
        />
        <StatCard
          title="Bugünkü Nema"
          value={totals.todayNema}
          tone={totals.todayNema > 0 ? 'pos' : 'neutral'}
          hint={totals.earning > 0 ? `${formatTRY(totals.earning)} nemalanıyor` : 'Oran tanımlı hesap yok'}
        />
        <StatCard
          title="Aylık Tahmini Nema"
          value={monthlyEstimate}
          hint="Bugünkü bakiye ve oranla 30 gün"
        />
        <StatCard
          title="Toplam Nema Geliri"
          value={totals.totalNema}
          tone={totals.totalNema > 0 ? 'pos' : 'neutral'}
          hint="Bugüne kadar biriken faiz"
        />
      </div>

      {canWrite && missingPresets.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-ink">
                Eksik hesaplar: {missingPresets.map((p) => p.name).join(', ')}
              </p>
              <p className="text-xs text-muted mt-0.5">
                Tek tıkla açılır; Midas %{formatRate(DEFAULT_NEMA_RATE)} nemalandırmayla gelir.
              </p>
            </div>
            <button
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() =>
                void guard(() =>
                  ensureAccounts(
                    missingPresets.map((p) => ({ name: p.name, type: p.type, nema_rate: p.nema_rate }))
                  )
                )
              }
            >
              Hesapları ekle
            </button>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------- hesap bakiyeleri */}
      <Card
        title="Hesap Bakiyeleri"
        actions={<span className="text-xs text-muted">Toplam {formatTRY(totals.cash)}</span>}
      >
        {activeAccounts.length === 0 ? (
          <Empty>Önce Hesaplar sayfasından ya da yukarıdaki düğmeyle hesap ekle.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className="th">Hesap</th>
                  <th className="th">Nemalandırma</th>
                  <th className="th text-right">Bakiye</th>
                  <th className="th text-right">Bugünkü nema</th>
                  <th className="th text-right">Aylık tahmini</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {activeAccounts.map((a) => {
                  const pct = Number(a.nema_rate ?? 0)
                  return (
                    <tr key={a.id} className="hover:bg-surface2/50">
                      <td className="td">
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted">
                          {a.lastMove
                            ? `Son hareket · ${format(parseISO(a.lastMove.date), 'd MMM yyyy', { locale: tr })}`
                            : 'Hareket yok'}
                        </div>
                      </td>
                      <td className="td">
                        {pct > 0 ? (
                          <Badge tone="accent">%{formatRate(pct)} yıllık</Badge>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                      <td className={`td text-right num ${a.balance > 0 ? 'text-ink' : 'text-muted'}`}>
                        {formatTRY(a.balance)}
                      </td>
                      <td className={`td text-right num ${a.todayNema > 0 ? 'text-pos' : 'text-muted'}`}>
                        {a.todayNema > 0 ? `+${formatTRY(a.todayNema)}` : '—'}
                      </td>
                      <td className="td text-right num text-muted">
                        {pct > 0 && a.balance > 0
                          ? formatTRY(projectNema(a.balance, pct, 30))
                          : '—'}
                      </td>
                      <td className="td text-right whitespace-nowrap">
                        {canWrite && (
                          <div className="inline-flex gap-1">
                            <button className="btn-ghost text-xs" onClick={() => openMove('giris', a.id)}>
                              Giriş
                            </button>
                            <button
                              className="btn-ghost text-xs"
                              onClick={() => openMove('cikis', a.id)}
                              disabled={a.balance <= 0}
                            >
                              Çıkış
                            </button>
                            <button
                              className="btn-ghost text-xs"
                              onClick={() => openTransfer(a.id)}
                              disabled={a.balance <= 0 || activeAccounts.length < 2}
                            >
                              Aktar
                            </button>
                            <button className="btn-ghost text-xs" onClick={() => openNema(a)}>
                              Nema
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="td font-medium" colSpan={2}>
                    Toplam
                  </td>
                  <td className="td text-right num font-semibold">{formatTRY(totals.cash)}</td>
                  <td className="td text-right num font-semibold text-pos">
                    {totals.todayNema > 0 ? `+${formatTRY(totals.todayNema)}` : '—'}
                  </td>
                  <td className="td text-right num text-muted">{formatTRY(monthlyEstimate)}</td>
                  <td className="td"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Nema her gün, o günün kapanış bakiyesi üzerinden işler ve bakiyeye eklenir; ertesi gün
          faiz üzerine faiz yürür. Uygulamayı günlerce açmasan da açtığında aradaki günler geriye
          dönük tamamlanır. Yazan tutar brüttür — stopaj düşülmez.
        </p>
        <p className="mt-1 text-xs text-muted">
          Buradaki bakiye Dashboard'daki toplam varlığa "hesaplarda bekleyen nakit" olarak
          girer; aynı parayı Yeni Giriş'te ayrıca kalem olarak yazma, iki kez sayılır.
        </p>
      </Card>

      {/* ------------------------------------------------------- hareketler */}
      <Card
        title="Para Hareketleri"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="text-xs py-1"
              value={filterAccount}
              onChange={(e) => setFilterAccount(e.target.value)}
            >
              <option value="">Tüm hesaplar</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select
              className="text-xs py-1"
              value={filterKind}
              onChange={(e) => setFilterKind(e.target.value as KindFilter)}
            >
              <option value="gunluk">Nema hariç</option>
              <option value="nema">Sadece nema</option>
              <option value="tumu">Tümü</option>
            </select>
          </div>
        }
      >
        {moves.length === 0 ? (
          <Empty>Bu filtrede hareket yok.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  <th className="th">Tarih</th>
                  <th className="th">Hesap</th>
                  <th className="th">Tür</th>
                  <th className="th">Açıklama</th>
                  <th className="th text-right">Tutar</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {visibleMoves.map((l) => {
                  const amt = Number(l.amount)
                  const kind = l.kind as LedgerKind
                  return (
                    <tr key={l.id} className="hover:bg-surface2/50">
                      <td className="td whitespace-nowrap text-muted">
                        {format(parseISO(l.date), 'd MMM yyyy', { locale: tr })}
                      </td>
                      <td className="td">{accountName(l.account_id)}</td>
                      <td className="td">
                        <Badge tone={LEDGER_TONES[kind] ?? 'muted'}>
                          {LEDGER_LABELS[kind] ?? kind}
                        </Badge>
                      </td>
                      <td className="td text-muted text-xs">{l.note ?? '—'}</td>
                      <td className={`td text-right num ${amt >= 0 ? 'text-pos' : 'text-neg'}`}>
                        {amt >= 0 ? '+' : '−'}
                        {formatTRY(Math.abs(amt))}
                      </td>
                      <td className="td text-right">
                        {canWrite && kind === 'nema' && (
                          <span className="text-xs text-muted">otomatik</span>
                        )}
                        {/* Borç hareketleri alacak kaydına bağlı; oradan yönetilir */}
                        {canWrite && l.receivable_id && (
                          <span className="text-xs text-muted">Gelir / Gider</span>
                        )}
                        {canWrite && kind !== 'nema' && !l.receivable_id && (
                          <button className="btn-danger text-xs" onClick={() => void del(l.id)}>
                            Sil
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {moves.length > visibleMoves.length && (
          <button className="btn-ghost text-xs mt-3" onClick={() => setShowAll(true)}>
            Kalan {moves.length - visibleMoves.length} hareketi göster
          </button>
        )}
      </Card>

      {/* ----------------------------------------------------------- modal */}
      <Modal
        open={modal?.type === 'move'}
        title={modal?.type === 'move' && modal.kind === 'giris' ? 'Para Girişi' : 'Para Çıkışı'}
        onClose={() => setModal(null)}
      >
        {modal?.type === 'move' && (
          <form onSubmit={submitMove} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="label">Hesap</label>
                <select
                  className="w-full"
                  value={modal.accountId}
                  onChange={(e) => setModal({ ...modal, accountId: e.target.value })}
                >
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {formatTRY(a.balance)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Tutar</label>
                <NumberInput className="w-full num" value={amount} onChange={setAmount} autoFocus />
              </div>
              <div>
                <label className="label">Tarih</label>
                <input
                  type="date"
                  className="w-full"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Açıklama</label>
                <input
                  className="w-full"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={modal.kind === 'giris' ? 'Örn. maaş, açılış bakiyesi' : 'Örn. harcama, havale'}
                />
              </div>
            </div>
            <p className="text-xs text-muted">
              {modal.kind === 'giris'
                ? 'Hesaba giren para bakiyeye eklenir; nemalandırma tanımlıysa aynı günden itibaren faiz işler.'
                : 'Çıkan para bakiyeden düşer ve toplam varlığından da düşer. Başka hesabına gönderiyorsan "Aktar" kullan.'}
            </p>
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

      <Modal open={modal?.type === 'transfer'} title="Hesaplar Arası Aktarım" onClose={() => setModal(null)}>
        {modal?.type === 'transfer' && (
          <form onSubmit={submitTransfer} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Nereden</label>
                <select
                  className="w-full"
                  value={modal.from}
                  onChange={(e) => setModal({ type: 'transfer', from: e.target.value })}
                >
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {formatTRY(a.balance)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Nereye</label>
                <select
                  className="w-full"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  required
                >
                  <option value="" disabled>
                    Hedef seç…
                  </option>
                  {activeAccounts
                    .filter((a) => a.id !== modal.from)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="label">Tutar</label>
                <NumberInput className="w-full num" value={amount} onChange={setAmount} autoFocus />
              </div>
              <div>
                <label className="label">Tarih</label>
                <input
                  type="date"
                  className="w-full"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Açıklama</label>
                <input className="w-full" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted">
              Para sende kaldığı için toplam varlığın değişmez; yalnızca hangi hesapta durduğu
              değişir. Nemalandırma hedef hesabın oranıyla işlemeye devam eder.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button className="btn-primary" disabled={busy}>
                {busy ? 'Aktarılıyor…' : 'Aktar'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={modal?.type === 'nema'} title="Nemalandırma Ayarı" onClose={() => setModal(null)}>
        {modal?.type === 'nema' && (
          <form onSubmit={submitNema} className="space-y-3">
            {formError && <ErrorBox message={formError} />}
            <p className="text-sm text-muted">
              <span className="text-ink font-medium">{modal.account.name}</span> hesabında duran nakde
              her gün faiz işlensin. Midas'ın güncel oranı %{formatRate(DEFAULT_NEMA_RATE)}.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Yıllık oran (%)</label>
                <NumberInput className="w-full num" value={rate} onChange={setRate} autoFocus />
              </div>
              <div>
                <label className="label">Başlangıç (boşsa ilk hareket)</label>
                <input
                  type="date"
                  className="w-full"
                  value={nemaStart}
                  onChange={(e) => setNemaStart(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted">
              Günlük faiz = bakiye × oran ÷ 365. Oranı 0 yaparsan faiz durur; işlenmiş günler
              defterde kalır. Başlangıç tarihi geçmişe alınırsa aradaki günler hemen hesaplanır.
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                className="btn-ghost mr-auto"
                disabled={busy}
                onClick={() => {
                  if (!confirm('Bu hesabın nema geçmişi silinip güncel oranla baştan hesaplansın mı?'))
                    return
                  void guard(() => recalcNema(modal.account.id))
                }}
              >
                Geçmişi yeniden hesapla
              </button>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)}>
                Vazgeç
              </button>
              <button className="btn-primary" disabled={busy}>
                {busy ? 'İşleniyor…' : 'Kaydet'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
