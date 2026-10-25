/**
 * CSS injection side-effect module.
 *
 * Self-accepting HMR module: when index.css changes, Vite re-runs only
 * this file and updates the <style> tag in place. It never propagates
 * the invalidation up to main.tsx, so createRoot is never called twice
 * and the removeChild / insertBefore DOM crash cannot occur.
 */
import appCss from './index.css?inline'

function applyStyles(css: string) {
  let el = document.getElementById('payrun-styles') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'payrun-styles'
    document.head.appendChild(el)
  }
  el.textContent = css
}

applyStyles(appCss)

// Self-accept so HMR updates only this module and never bubbles up to main.tsx
if (import.meta.hot) {
  import.meta.hot.accept((newMod) => {
    // newMod is undefined when the accept handler runs — the re-execution above
    // already ran applyStyles with the updated appCss, so nothing more to do.
    void newMod
  })
}
