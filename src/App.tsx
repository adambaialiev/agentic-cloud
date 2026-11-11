import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import Landing from './pages/Landing'
import Home from './pages/Home'

const OgPreview = lazy(() => import('./pages/OgPreview'))
const TermsOfService = lazy(() => import('./pages/TermsOfService'))
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'))
/* The three entry pages share one module: they are one layout and three
   specs, and splitting them into three chunks would download the same layout
   three times. */
const ClaudeCodeInTheCloud = lazy(() => import('./pages/EntryPages'))
const CodexInTheCloud = lazy(() =>
  import('./pages/EntryPages').then((m) => ({ default: m.CodexInTheCloud })),
)
const AiAgentsForYourTeam = lazy(() =>
  import('./pages/EntryPages').then((m) => ({ default: m.AiAgentsForYourTeam })),
)
const FourPhases = lazy(() => import('./pages/FourPhases'))
const WhyFly = lazy(() => import('./pages/WhyFly'))
const SelfHosted = lazy(() => import('./pages/SelfHosted'))
const OpenSource = lazy(() => import('./pages/OpenSource'))
/* The documentation is one module too: the contents page and every chapter
   share a layout and one chapter list, so one chunk serves all of /docs. */
const DocsIndex = lazy(() => import('./pages/Docs').then((m) => ({ default: m.DocsIndex })))
const DocsChapter = lazy(() => import('./pages/Docs'))

/**
 * The catch-all redirect, carrying the query string home with it — a bare
 * `<Navigate to="/">` drops it, and links shared with tracking or deep-link
 * parameters should land on the same page they name.
 */
function RedirectHome() {
  const { search } = useLocation()
  return <Navigate to={{ pathname: '/', search }} replace />
}

function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        {/* The front door for a stranger since note #774 (the owner,
            2026-10-18): the apps and this week's builders, then a door to
            the product. The pitch that stood here moved, unchanged, to
            /product. A signed-in browser never sees / (index.html). */}
        <Route path="/" element={<Home />} />
        <Route path="/product" element={<Landing />} />
        <Route path="/terms" element={<TermsOfService />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        {/* Entry pages: one address per question a search brings someone in
            with, each answering it with the front page's own claims. */}
        <Route path="/claude-code-in-the-cloud" element={<ClaudeCodeInTheCloud />} />
        <Route path="/codex-in-the-cloud" element={<CodexInTheCloud />} />
        <Route path="/ai-agents-for-your-team" element={<AiAgentsForYourTeam />} />
        {/* The four phases of AI at work, off the front page since note #199
            and told at more length here. */}
        <Route path="/four-phases" element={<FourPhases />} />
        {/* Why your own Agentic Cloud runs on Fly, for the engineer whose
            company is on AWS or Google Cloud (note #838). */}
        <Route path="/why-fly" element={<WhyFly />} />
        {/* Topic pages for the searches the site was not found for (note
            #1154, from Iris's search report, note #1144). */}
        <Route path="/self-hosted-coding-agents" element={<SelfHosted />} />
        <Route path="/open-source" element={<OpenSource />} />
        {/* The private copy, for a company's engineer (note #818): linked
            from /product only. */}
        <Route path="/own-cloud" element={<Navigate to="/" replace />} />
        {/* Its first address (notes #818, #827), in outreach, the installer's
            README and the film. The edge answers it with a 301
            (public/_redirects); this covers a click inside the app. */}
        <Route path="/private-copy" element={<Navigate to="/" replace />} />
        {/* The documentation: the contents at /docs, one chapter per slug
            (src/docs/chapters.ts). An unknown slug lands on the contents. */}
        <Route path="/docs" element={<DocsIndex />} />
        <Route path="/docs/:slug" element={<DocsChapter />} />
        {/* /teams was this page's address until 2026-08-29, and the link has
            been forwarded into group chats — the one place we cannot go back
            and edit. It serves the same pitch rather than bouncing to it: a
            redirect costs a flash and needs JavaScript, and emitting no file
            here left the CDN serving its cached copy of the OLD page for as
            long as its cache header allowed. entry-server marks this address
            noindex with a canonical pointing home. */}
        <Route path="/teams" element={<Landing />} />
        <Route path="/og-preview" element={<OgPreview />} />
        {/* Full-page requests to the retired /pricing URL are redirected at the
            edge by public/_redirects. This catch-all covers client navigation,
            development, the old dashboard, and retired /en and /ru locales. */}
        <Route path="*" element={<RedirectHome />} />
      </Routes>
    </Suspense>
  )
}

export default App
