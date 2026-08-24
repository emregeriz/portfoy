import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)

/**
 * Service worker — telefonda ana ekrandan uygulama gibi açılabilmesi için.
 * Yalnızca üretim derlemesinde kaydedilir; geliştirme sunucusunda önbellek
 * değişiklikleri gizlemesin.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Kayıt olmazsa uygulama normal site olarak çalışmaya devam eder
    })
  })
}
