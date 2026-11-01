import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from './App'

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <span data-testid="location">{pathname + search}</span>
}

describe('App routes', () => {
  it('renders the English landing page at the index route', () => {
    render(
      <MemoryRouter initialEntries={['/en']}>
        <App />
      </MemoryRouter>,
    )

    // The copy's door since note #822; nothing on the site sends a stranger
    // to sign up. Since note #924 the home page's one door is How to start,
    // a text link to its own section, and the header has none.
    expect(screen.getAllByRole('link', { name: /How to start/ })
      .every((el) => el.getAttribute('href') === '#start')).toBe(true)
    expect(screen.queryAllByRole('link', { name: /Build yours|Sign in/ })).toEqual([])
    expect(screen.getAllByRole('link').some((el) => el.getAttribute('href') === '/signup'))
      .toBe(false)
    expect(screen.getAllByRole('link').some((el) => el.getAttribute('href')?.includes('t.me')))
      .toBe(false)
  })

  // /teams was the team pitch's address until 2026-08-29, when that pitch
  // became the front page. The link had already been forwarded into group
  // chats — the one place we cannot go back and edit — so it still answers,
  // with the pitch itself rather than a redirect to it.
  it('still serves the pitch at the old /teams address', () => {
    render(
      <MemoryRouter initialEntries={['/teams']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Everything an agent needs to finish the job.' })).toBeTruthy()
    // It stays where the reader landed — no bounce, nothing to wait for.
    expect(screen.getByTestId('location').textContent).toBe('/teams')
  })

  it('serves the Terms of Service at /terms', async () => {
    render(
      <MemoryRouter initialEntries={['/terms']}>
        <App />
      </MemoryRouter>,
    )

    // Lazy route — wait for the chunk.
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' }, { timeout: 10_000 })).toBeTruthy()
    // What the terms now have to get right (note #664, 2026-09-25): a new
    // workplace brings no cloud account. Its machines and sites run on ours
    // (services/org-fly.ts resolveHostingContext), at no charge, within the
    // per-workplace limits. Until then they ran in the organisation's own
    // Fly account, and these terms said so.
    expect(screen.getByText(/Agent machines and the sites your\s+agents deploy run on our own Fly.io account/)).toBeTruthy()
    expect(screen.getByText(/we do not buy, hold or resell model access/i)).toBeTruthy()
  })

  it('serves the Privacy Policy at /privacy', async () => {
    render(
      <MemoryRouter initialEntries={['/privacy']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { level: 1, name: 'Privacy Policy' }, { timeout: 10_000 })).toBeTruthy()
    expect(screen.getByText(/rolling window of\s+up to 500 chat rows per agent/)).toBeTruthy()
    expect(screen.getByText(/AI sign-in tokens, saved\s+organisation secrets/)).toBeTruthy()
  })

  it('redirects the retired pricing URL home and preserves its query string', () => {
    render(
      <MemoryRouter initialEntries={['/pricing?utm_source=shared']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('location').textContent).toBe('/?utm_source=shared')
    expect(screen.queryByRole('heading', { level: 1, name: 'Pricing' })).toBeNull()
  })

  it('serves the team pitch at /teams', async () => {
    render(
      <MemoryRouter initialEntries={['/teams']}>
        <App />
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Everything an agent needs to finish the job.' },
        { timeout: 10_000 },
      ),
    ).toBeTruthy()
  })

  // /refunds was retired on 2026-09-14: a whole page to say a free product
  // takes no payments was one more surface to keep true. The SPA sends it home
  // like any unknown path, and public/_redirects 301s it to /terms at the edge,
  // where its two load-bearing sentences now live.
  it('no longer serves a payments page, and keeps its claims in the Terms', async () => {
    render(
      <MemoryRouter initialEntries={['/refunds']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(screen.queryByRole('heading', { level: 1, name: 'Payments and refunds' })).toBeNull()

    render(
      <MemoryRouter initialEntries={['/terms']}>
        <App />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' }, { timeout: 10_000 })).toBeTruthy()
    expect(screen.getByText(/there is no platform payment to refund/)).toBeTruthy()
    expect(screen.getByText(/was not collected by this service/)).toBeTruthy()
  })

  it.each([
    ['/claude-code-in-the-cloud', 'Run Claude Code in the cloud, on the plan you already have.'],
    ['/codex-in-the-cloud', 'Run Codex in the cloud, beside your Claude Code agents.'],
    ['/ai-agents-for-your-team', 'A whole team of AI agents, run by one person.'],
    // Not an entry page, but built like one: its own door, the front page
    // one link away (note #199).
    ['/four-phases', 'AI at work has four phases. Start in the fourth.'],
  ])('serves the entry page at %s', async (path, headline) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { level: 1, name: headline }, { timeout: 10_000 })).toBeTruthy()
    // The door is the private copy (note #822), and the whole story is one
    // link away.
    expect(screen.getAllByRole('link', { name: /Build your own Agentic Cloud/ })
      .every((el) => el.getAttribute('href') === '/#give-your-agent')).toBe(true)
    expect(screen.getAllByRole('link', { name: 'See the whole product' })
      .every((el) => el.getAttribute('href') === '/product')).toBe(true)
  })

  // Your own Agentic Cloud is the home page since note #832: /own-cloud
  // (note #829) and /private-copy (notes #818, #827) are in outreach and the
  // film, so a click inside the app lands on it, as the edge's 301 does.
  it.each(['/own-cloud', '/private-copy'])('sends %s to the one home page', async (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { level: 1, name: 'Your agents are great engineers. Give them a workplace.' }, { timeout: 10_000 })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3, name: 'Give this to your agent' })).toBeTruthy()
  })

  it('redirects unknown (formerly dashboard) paths back to the landing page', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <App />
      </MemoryRouter>,
    )

    // The copy's door since note #822; nothing on the site sends a stranger
    // to sign up. Since note #924 the home page's one door is How to start,
    // a text link to its own section, and the header has none.
    expect(screen.getAllByRole('link', { name: /How to start/ })
      .every((el) => el.getAttribute('href') === '#start')).toBe(true)
    expect(screen.queryAllByRole('link', { name: /Build yours|Sign in/ })).toEqual([])
    expect(screen.getAllByRole('link').some((el) => el.getAttribute('href') === '/signup'))
      .toBe(false)
    expect(screen.getAllByRole('link').some((el) => el.getAttribute('href')?.includes('t.me')))
      .toBe(false)
  })

  it('carries a query string home on an unknown route', () => {
    render(
      <MemoryRouter initialEntries={['/checkout?_ptxn=txn_01abc']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('location').textContent).toBe('/?_ptxn=txn_01abc')
  })
})
