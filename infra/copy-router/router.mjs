#!/usr/bin/env node
/**
 * Copy router (note #804): what infra/preview-router (a Cloudflare Worker) does
 * for agentbuilt.app, as a small Fly app inside a private copy's own
 * organization. Every agent's preview and every hosted site answers on
 * `<name>.<APPS_DOMAIN>`: Fly's edge terminates TLS with ONE wildcard
 * certificate on this app, this process asks the copy's backend which Fly app
 * holds the name (GET /api/preview-map/<name>, the same map the Worker asks),
 * and forwards to `<app>.fly.dev`, whose edge wakes a sleeping machine.
 *
 * Zero dependencies, one file, Node >= 20 — the same rule as the git host.
 *
 * Env:
 *   APPS_DOMAIN   e.g. copy.example.com (names are <label>.APPS_DOMAIN)
 *   BACKEND_URL   where the map is asked, e.g. http://copy-backend.internal:8080
 *   PORT          listen port (default 8080)
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const APPS_DOMAIN = (process.env.APPS_DOMAIN || '').trim().toLowerCase();
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 8080);
if (!APPS_DOMAIN || !BACKEND_URL) {
  console.error('[copy-router] APPS_DOMAIN and BACKEND_URL are required');
  process.exit(1);
}

// Same numbers and reasons as infra/preview-router/worker.js.
const MAP_TTL_MS = 300_000;
const STALE_TTL_MS = 7 * 24 * 3600_000;
const LOOKUP_TIMEOUT_MS = 5000;
const WAKE_RETRY_STATUSES = new Set([502, 503]);
const WAKE_RETRY_DELAY_MS = 3000;
const WAKE_RETRY_TOTAL_MS = 30_000;
const NAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REDIRECT_URL = new RegExp(`^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.${APPS_DOMAIN.replace(/\./g, '\\.')}$`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** name → { target, fetchedAt } — fresh for MAP_TTL_MS, a fallback for STALE_TTL_MS. */
const cache = new Map();

function targetFrom(body) {
  const app = typeof body?.app === 'string' ? body.app.trim() : '';
  if (/^[a-z0-9-]{1,63}$/.test(app)) return { app };
  const redirect = typeof body?.redirect === 'string' ? body.redirect.trim() : '';
  if (REDIRECT_URL.test(redirect)) return { redirect };
  return null;
}

async function resolveName(name) {
  const hit = cache.get(name);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < MAP_TTL_MS) return { target: hit.target };
  const response = await fetch(`${BACKEND_URL}/api/preview-map/${name}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch(() => null);
  if (response?.status === 404) {
    cache.delete(name);
    return { target: null };
  }
  if (response?.ok) {
    const target = targetFrom(await response.json().catch(() => null));
    if (target) cache.set(name, { target, fetchedAt: now });
    return { target };
  }
  if (hit && now - hit.fetchedAt < STALE_TTL_MS) return { target: hit.target };
  return { target: null, unavailable: true };
}

function nameOf(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (!host.endsWith(`.${APPS_DOMAIN}`)) return null;
  const label = host.slice(0, -(APPS_DOMAIN.length + 1));
  return NAME_LABEL.test(label) ? { label, host } : null;
}

/** Request headers for the origin hop: Host follows the target, the visitor's name rides along. */
function originHeaders(req, appHost, visitorHost) {
  const headers = { ...req.headers, host: appHost, 'x-forwarded-host': visitorHost };
  delete headers.connection;
  delete headers['keep-alive'];
  return headers;
}

function forwardOnce(req, appHost, visitorHost, body, signal) {
  return new Promise((resolve, reject) => {
    const upstream = https.request({
      host: appHost, servername: appHost, port: 443, method: req.method, path: req.url,
      headers: originHeaders(req, appHost, visitorHost), signal,
    }, resolve);
    upstream.on('error', reject);
    if (body) upstream.end(body); else req.pipe(upstream);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/__router/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, domain: APPS_DOMAIN, cached: cache.size }));
  }
  const named = nameOf(req.headers.host);
  if (!named) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('No such preview.\n');
  }
  const { target, unavailable } = await resolveName(named.label);
  if (!target) {
    res.writeHead(unavailable ? 503 : 404, { 'content-type': 'text/plain', ...(unavailable ? { 'retry-after': '30' } : {}) });
    return res.end(unavailable ? 'This preview cannot be reached right now. Try again in a minute.\n' : 'No such preview.\n');
  }
  if (target.redirect) {
    const url = new URL(req.url, 'http://x');
    res.writeHead(301, { location: `${target.redirect}${url.pathname}${url.search}` });
    return res.end();
  }
  const appHost = `${target.app}.fly.dev`;
  const plainRead = (req.method === 'GET' || req.method === 'HEAD') && !req.headers.upgrade;
  try {
    // A plain read carries no body, so it can be asked again while Fly's edge
    // wakes the machine (502/503 for the seconds before its server listens).
    let upstream = await forwardOnce(req, appHost, named.host, plainRead ? Buffer.alloc(0) : null);
    if (plainRead && WAKE_RETRY_STATUSES.has(upstream.statusCode)) {
      const deadline = Date.now() + WAKE_RETRY_TOTAL_MS;
      while (Date.now() + WAKE_RETRY_DELAY_MS < deadline) {
        upstream.resume();
        await sleep(WAKE_RETRY_DELAY_MS);
        try {
          upstream = await forwardOnce(req, appHost, named.host, Buffer.alloc(0), AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        } catch {
          break;
        }
        if (!WAKE_RETRY_STATUSES.has(upstream.statusCode)) break;
      }
    }
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('This preview did not answer.\n');
    console.warn(`[copy-router] ${named.label} → ${appHost}: ${error?.message || error}`);
  }
});

// WebSockets (dev servers' live reload, terminals): a raw TLS pipe to the app.
server.on('upgrade', async (req, socket, head) => {
  const named = nameOf(req.headers.host);
  const { target } = named ? await resolveName(named.label) : { target: null };
  if (!target?.app) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const appHost = `${target.app}.fly.dev`;
  const upstream = tls.connect({ host: appHost, servername: appHost, port: 443 }, () => {
    const headers = originHeaders(req, appHost, named.host);
    headers.connection = 'Upgrade';
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '::', () => console.log(`[copy-router] *.${APPS_DOMAIN} → map at ${BACKEND_URL}, listening on ${PORT}`));
