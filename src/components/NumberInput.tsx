import { useRef, type InputHTMLAttributes, type ChangeEvent } from 'react'
import { formatTRInput } from '../lib/currency'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
}

/**
 * Binlik ayracını yazarken uygulayan sayı alanı.
 *
 * Biçimlendirme metnin uzunluğunu değiştirdiği için imleç, sağdan uzaklığı
 * korunarak geri konur — sayının ortasında düzeltme yaparken imleç sona
 * atlamaz.
 */
export default function NumberInput({ value, onChange, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null)

  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target
    const fromRight = el.value.length - (el.selectionStart ?? el.value.length)
    onChange(formatTRInput(el.value))
    requestAnimationFrame(() => {
      const node = ref.current
      if (!node || document.activeElement !== node) return
      const pos = Math.max(0, node.value.length - fromRight)
      node.setSelectionRange(pos, pos)
    })
  }

  return <input ref={ref} inputMode="decimal" value={value} onChange={handle} {...rest} />
}
