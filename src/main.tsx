import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { rememberFirstVisit } from '../backend/src/shared/first-visit'
import { rememberArrival } from './lib/guest-arrival'

// The site that sent this browser here, noted once on its first visit and
// sent along only if the person creates an account (shared/first-visit.ts).
rememberFirstVisit(window)
// This visit's link tags and referring site, kept for the tab and sent only
// with Start guest agent (note #1139, lib/guest-arrival.ts).
rememberArrival(window)

const container = document.getElementById('root')!

const tree = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)

// Public routes ship prerendered (scripts/prerender.mjs), so their markup is
// already in the document and must be adopted rather than thrown away —
// createRoot on server-rendered HTML wipes it and repaints, which is the flash
// prerendering exists to remove. Unmatched paths still arrive as the empty
// SPA shell, hence the branch.
// Exported so a test can take it down again. Nothing in the browser uses it:
// the page mounts once and lives until the tab closes. A TEST imports this
// module repeatedly, and a root left mounted keeps React's scheduler alive
// after the test's DOM is gone — which surfaces as `window is not defined`
// thrown from a lazy route chunk resolving into a torn-down environment,
// after every test has already passed.
export const root = container.hasChildNodes()
  ? hydrateRoot(container, tree)
  : (() => {
    const created = createRoot(container)
    created.render(tree)
    return created
  })()
