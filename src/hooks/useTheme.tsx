import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark'

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: 'light',
  toggle: () => {},
})

function getInitialTheme(): Theme {
  try {
    if (localStorage.getItem('theme') === 'dark') return 'dark'
  } catch {
    // localStorage kapalıysa varsayılan tema kullanılır
  }
  return 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // yok say
    }
  }, [theme])

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}

// Recharts SVG öğeleri CSS değişkenlerini okuyamadığı için grafik renkleri tema bazlı sabit
const CHART_COLORS = {
  light: {
    grid: '#e2e8f0',
    tick: '#64748b',
    tickStrong: '#334155',
    legend: '#64748b',
    tooltipBg: '#ffffff',
    tooltipBorder: '#dde4ee',
    cursor: '#0f172a0d',
  },
  dark: {
    grid: '#243047',
    tick: '#8b9ab3',
    tickStrong: '#c7d2e3',
    legend: '#8b9ab3',
    tooltipBg: '#1a2233',
    tooltipBorder: '#243047',
    cursor: '#ffffff08',
  },
} as const

export function useChartColors() {
  return CHART_COLORS[useTheme().theme]
}
