import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import postcss from 'postcss'

/**
 * The Workspace's own stylesheet, fenced inside `.ws-live`.
 *
 * The landing renders real Workspace components (src/components/LiveFleet.tsx)
 * so the product on the page IS the product, not a drawing of it. Those
 * components are styled by backend/workspace-ui/src/workspace.css, which was
 * written for a page it owns whole: it sets `body`, `:root`, `h2`, `button`.
 * Imported as-is it would restyle the marketing page around it, so every
 * selector is prefixed on the way in:
 *
 *   :root       -> .ws-live          (its variables, on the panel)
 *   html, body  -> dropped           (the panel's own block in index.css
 *                                     carries the font and colour)
 *   body.x ...  -> dropped           (page-wide modes a panel never enters)
 *   anything    -> .ws-live anything
 *
 * @keyframes are left alone; @media blocks are walked. Nothing inside the
 * app's stylesheet is edited for the landing's sake — the fence is here so
 * that the app can change freely and the panel follows.
 */
const WS_SCOPE = '.ws-live'

function scopeWorkspaceCss(): Plugin {
  return {
    name: 'scope-workspace-css',
    enforce: 'pre',
    transform(code, id) {
      if (!/backend\/workspace-ui\/src\/workspace\.css(\?.*)?$/.test(id)) return
      const root = postcss.parse(code)
      root.walkRules((rule) => {
        const parent = rule.parent
        if (parent && parent.type === 'atrule' && /keyframes$/.test((parent as postcss.AtRule).name)) return
        const selectors = rule.selectors.flatMap((selector) => {
          const s = selector.trim()
          if (s === ':root') return [WS_SCOPE]
          if (/^(html|body)(\b|$)/.test(s)) return []
          return [`${WS_SCOPE} ${s}`]
        })
        if (selectors.length === 0) rule.remove()
        else rule.selectors = selectors
      })
      return { code: root.toString(), map: null }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [scopeWorkspaceCss(), react(), tailwindcss()],
    resolve: {
      // The Workspace components the landing renders live under backend/,
      // which has its own node_modules and its own React. Every import of
      // these resolves to the site's copy, or the page would ship two Reacts
      // and the panel's hooks would run on the wrong one.
      dedupe: ['react', 'react-dom', 'react-router-dom'],
    },
    // `vite preview` reads the home page's live apps and board from
    // production, so a local build shows what a visitor will see.
    preview: {
      proxy: {
        '/workspace/api/public': { target: 'https://agenticcloudcomputer.com', changeOrigin: true },
      },
    },
    server: {
      proxy: {
        '/api': {
          target: env.VITE_API_BASE_URL || 'http://localhost:3001',
          changeOrigin: true
        }
      }
    }
  }
})
