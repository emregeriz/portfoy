import { createContext, useContext, useMemo, useState } from 'react'
import { setMoneyMasked } from '../lib/currency'

/**
 * Bakiye gizleme — ekranı birine gösterirken tutarları ₺***** yapar.
 *
 * Durum bilerek App bileşeninde tutuluyor (useMaskState). Sağlayıcının
 * içinde tutulsaydı `children` referansı değişmediği için React alt ağacı
 * yeniden render etmez, tutarlar eski haliyle ekranda kalırdı. App'te
 * tutulunca Routes ve altındaki her sayfa yeniden render olur.
 *
 * Tercih tarayıcıda saklanır; sayfa yenilenince kaldığı yerden devam eder.
 */
const KEY = 'maskMoney'

interface MaskValue {
  masked: boolean
  toggle: () => void
}

const MaskContext = createContext<MaskValue>({ masked: false, toggle: () => {} })

function initial(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    // localStorage kapalıysa gizleme kapalı başlar
    return false
  }
}

/** App bu hook'u çağırır ve dönen değeri MaskProvider'a verir. */
export function useMaskState(): MaskValue {
  const [masked, setMasked] = useState(initial)

  // Render sırasında yazılır: alt ağaç biçimlendiriciyi bundan sonra okuyor
  setMoneyMasked(masked)

  return useMemo(
    () => ({
      masked,
      toggle: () =>
        setMasked((m) => {
          const next = !m
          try {
            localStorage.setItem(KEY, next ? '1' : '0')
          } catch {
            // yok say
          }
          return next
        }),
    }),
    [masked]
  )
}

export function MaskProvider({ value, children }: { value: MaskValue; children: React.ReactNode }) {
  return <MaskContext.Provider value={value}>{children}</MaskContext.Provider>
}

export function useMask() {
  return useContext(MaskContext)
}
