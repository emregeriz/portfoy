/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0f17',
        surface: '#121826',
        surface2: '#1a2233',
        border: '#243047',
        muted: '#8b9ab3',
        accent: '#4f8cff',
        pos: '#22c55e',
        neg: '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
