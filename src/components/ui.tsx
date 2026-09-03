import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 mb-3">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-muted">{children}</div>
}

export function Spinner({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div className="py-10 text-center text-sm text-muted flex items-center justify-center gap-2">
      <span className="w-4 h-4 rounded-full border-2 border-border border-t-accent animate-spin" />
      {label}
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-neg/40 bg-neg/10 text-neg px-3 py-2 text-sm">
      {message}
    </div>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    muted: 'bg-surface2 text-muted border-border',
    pos: 'bg-pos/15 text-pos border-pos/30',
    neg: 'bg-neg/15 text-neg border-neg/30',
    accent: 'bg-accent/15 text-accent border-accent/30',
    warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
        tones[tone] ?? tones.muted
      }`}
    >
      {children}
    </span>
  )
}

export interface ActionItem {
  label: string
  /** Ne yapacağını tek satırda anlatır — menüde etiketin altında görünür */
  hint?: string
  tone?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  onSelect: () => void
}

/**
 * Tek düğme altında toplanan işlem listesi.
 *
 * Yan yana dizilen yarım düzine düğme yerine "İşlem" düğmesi açılır, ne
 * yapacağını listeden seçersin. Sıradaki adım en üstte ve vurgulu durur;
 * silme gibi geri dönüşü olmayanlar en altta, kırmızı.
 *
 * `items` boş gelirse hiçbir şey çizilmez — duruma göre işlem kalmadıysa
 * ekranda boş bir düğme asılı kalmasın diye.
 */
export function ActionMenu({
  label = 'İşlem',
  items,
}: {
  label?: string
  items: ActionItem[]
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!items.length) return null

  const tones: Record<string, string> = {
    default: 'text-ink',
    primary: 'text-accent font-medium',
    danger: 'text-neg',
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className="btn-ghost text-xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label} <span className="ml-1 text-[10px]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-30 mt-1 w-64 rounded-xl border border-border bg-surface shadow-2xl overflow-hidden"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent ${
                tones[it.tone ?? 'default']
              }`}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.label}
              {it.hint && <span className="block text-[11px] text-muted font-normal">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  // Escape ile kapanır — form içindeyken de çalışır
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-lg bg-surface border border-border rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Kapat"
            className="text-muted hover:text-ink text-lg leading-none px-1"
          >
            ×
          </button>
        </header>
        <div className="p-4 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}
