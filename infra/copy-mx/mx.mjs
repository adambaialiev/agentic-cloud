#!/usr/bin/env node
/**
 * Copy mail receiver (note #804): what Cloudflare Email Routing and the
 * `mail-inbound` Worker (infra/mail-inbound) do for agenticcloudcomputer.com,
 * as one small Fly app inside a private copy's own organization. The MX of
 * the copy's mail domain points at this app's own IPv4 address; Fly's proxy
 * forwards port 25 here with the PROXY protocol, so the sender's real address
 * is known for the SPF check.
 *
 * Per message, the same contract as the Worker: ask the backend whether
 * anybody holds the address (refuse at RCPT if not), then hand it the raw
 * bytes. What Cloudflare added for us — the sender checks — happens here:
 * mailauth runs SPF, DKIM, DMARC and ARC and the verdict is prepended as an
 * `Authentication-Results` header, which the backend already reads.
 *
 * Env:
 *   MAIL_DOMAIN          the only domain accepted, e.g. theirco.com
 *   MX_HOSTNAME          the name this server answers as, e.g. mx.theirco.com
 *   BACKEND_URL          e.g. http://copy-backend.internal:8080
 *   MAIL_INGEST_SECRET   the backend's ingest secret (Bearer)
 *   PORT                 default 2525 (Fly maps 25 → here)
 *   CERT_DIR             where the Let's Encrypt account, key and certificate
 *                        live (a small volume); unset = no certificate
 *   HTTP_PORT            default 8080 (Fly maps 80 → here) for the ACME
 *                        HTTP-01 challenge on the receiver's own address
 *   ACME_DIRECTORY       default Let's Encrypt production
 *   MX_STARTTLS=off      never offer STARTTLS, certificate or not
 */
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';
import { authenticate } from 'mailauth';
import acme from 'acme-client';

const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || '').trim().toLowerCase();
const MX_HOSTNAME = (process.env.MX_HOSTNAME || `mx.${MAIL_DOMAIN}`).trim().toLowerCase();
const BACKEND_URL = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
const SECRET = process.env.MAIL_INGEST_SECRET || '';
const PORT = Number(process.env.PORT || 2525);
// smtp-server's built-in certificate is a self-signed "localhost" one that
// expired in February 2025, and strict senders abort on it (Resend's own
// account mail did, 27 Oct 2026). So STARTTLS is offered only with a real
// certificate (note #807): Let's Encrypt for MX_HOSTNAME, proven over HTTP on
// this receiver's own address, kept in CERT_DIR and renewed 30 days ahead.
// Without one, senders deliver in the clear, as to any server that does not
// offer STARTTLS. MX_STARTTLS=off never offers it.
const STARTTLS = process.env.MX_STARTTLS !== 'off';
const CERT_DIR = (process.env.CERT_DIR || '').trim();
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const ACME_DIRECTORY = process.env.ACME_DIRECTORY || acme.directory.letsencrypt.production;
const RENEW_BEFORE_MS = 30 * 24 * 3600_000;
const RENEW_CHECK_MS = 12 * 3600_000;
// Cloudflare refuses anything over 25 MiB before the Worker sees it.
const MAX_BYTES = 25 * 1024 * 1024;
if (!MAIL_DOMAIN || !BACKEND_URL || !SECRET) {
  console.error('[copy-mx] MAIL_DOMAIN, BACKEND_URL and MAIL_INGEST_SECRET are required');
  process.exit(1);
}

const smtpError = (code, message) => Object.assign(new Error(message), { responseCode: code });
const ingest = (path, init = {}) => fetch(`${BACKEND_URL}/api/webhooks/mail${path}`, {
  ...init,
  headers: { authorization: `Bearer ${SECRET}`, ...(init.headers || {}) },
  signal: AbortSignal.timeout(20_000),
});

const server = new SMTPServer({
  name: MX_HOSTNAME,
  banner: 'mail receiver',
  authOptional: true,
  disabledCommands: ['AUTH'],
  // Shown only once a real certificate is loaded (installCertificate below).
  hideSTARTTLS: true,
  size: MAX_BYTES,
  // Fly's proxy speaks PROXY protocol v1 to this port (fly.toml handlers).
  useProxy: process.env.PROXY_PROTOCOL !== 'off',
  logger: false,
  async onRcptTo(address, _session, callback) {
    const to = String(address.address || '').trim().toLowerCase();
    if (!to.endsWith(`@${MAIL_DOMAIN}`)) {
      console.log(`[copy-mx] refused ${to}: not this domain`);
      return callback(smtpError(550, '5.7.1 Relaying denied'));
    }
    try {
      const lookup = await ingest(`/address?to=${encodeURIComponent(to)}`);
      if (!lookup.ok) throw new Error(`address lookup answered ${lookup.status}`);
      const answer = await lookup.json();
      if (answer?.deliverable !== true) {
        console.log(`[copy-mx] refused ${to}: nobody holds it`);
        return callback(smtpError(550, '5.1.1 No such address here'));
      }
      return callback();
    } catch (error) {
      console.warn(`[copy-mx] lookup ${to}: ${error?.message || error}`);
      return callback(smtpError(451, '4.3.0 Try again later'));
    }
  },
  onData(stream, session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (error) => callback(error));
    stream.on('end', async () => {
      if (stream.sizeExceeded) return callback(smtpError(552, '5.3.4 Message too big'));
      const raw = Buffer.concat(chunks);
      const from = session.envelope.mailFrom ? String(session.envelope.mailFrom.address || '') : '';
      let message = raw;
      try {
        const { headers } = await authenticate(raw, {
          ip: session.remoteAddress,
          helo: session.hostNameAppearsAs,
          sender: from,
          mta: MX_HOSTNAME,
        });
        message = Buffer.concat([Buffer.from(headers), raw]);
      } catch (error) {
        // An unverifiable message is still a message: the backend shows it as
        // an unverified sender, exactly as when the verdict is absent.
        console.warn(`[copy-mx] sender checks failed: ${error?.message || error}`);
      }
      let delivered = 0;
      let refused = 0;
      for (const rcpt of session.envelope.rcptTo) {
        const to = String(rcpt.address || '').toLowerCase();
        try {
          const response = await ingest('/inbound', {
            method: 'POST',
            headers: {
              'content-type': 'message/rfc822',
              'x-mail-to': to,
              'x-mail-from': from,
              'x-mail-size': String(message.length),
            },
            body: message,
          });
          if (response.ok) delivered += 1;
          else if (response.status === 404 || response.status === 413) refused += 1;
          else throw new Error(`ingest answered ${response.status}`);
          console.log(`[copy-mx] ${to} ← ${from || '<>'} ${raw.length} bytes: ${response.status}`);
        } catch (error) {
          console.warn(`[copy-mx] ${to}: ${error?.message || error}`);
          return callback(smtpError(451, '4.3.0 Could not store the message, try again later'));
        }
      }
      if (!delivered && refused) return callback(smtpError(550, '5.1.1 No such address here'));
      return callback(null, 'Delivered');
    });
  },
});
server.on('error', (error) => console.warn(`[copy-mx] ${error?.message || error}`));

// ── The certificate ────────────────────────────────────────────────────────
/** token → key authorization, answered on /.well-known/acme-challenge/. */
const challenges = new Map();
const certFiles = CERT_DIR
  ? { account: path.join(CERT_DIR, 'account.pem'), key: path.join(CERT_DIR, 'key.pem'), cert: path.join(CERT_DIR, 'cert.pem') }
  : null;

function installCertificate(key, cert) {
  server.updateSecureContext({ key, cert });
  server.options.hideSTARTTLS = false;
}

async function certificateNotAfter(cert) {
  const info = await acme.crypto.readCertificateInfo(cert);
  return new Date(info.notAfter).getTime();
}

async function ensureCertificate() {
  if (!STARTTLS || !certFiles) return;
  mkdirSync(CERT_DIR, { recursive: true });
  if (existsSync(certFiles.cert) && existsSync(certFiles.key)) {
    const cert = readFileSync(certFiles.cert);
    const key = readFileSync(certFiles.key);
    const notAfter = await certificateNotAfter(cert);
    if (notAfter - Date.now() > RENEW_BEFORE_MS) {
      if (server.options.hideSTARTTLS) {
        installCertificate(key, cert);
        console.log(`[copy-mx] STARTTLS on: certificate for ${MX_HOSTNAME} valid until ${new Date(notAfter).toISOString()}`);
      }
      return;
    }
  }
  const accountKey = existsSync(certFiles.account)
    ? readFileSync(certFiles.account)
    : await acme.crypto.createPrivateKey();
  writeFileSync(certFiles.account, accountKey, { mode: 0o600 });
  const client = new acme.Client({ directoryUrl: ACME_DIRECTORY, accountKey });
  const [key, csr] = await acme.crypto.createCsr({ commonName: MX_HOSTNAME });
  const cert = await client.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: ['http-01'],
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => { challenges.set(challenge.token, keyAuthorization); },
    challengeRemoveFn: async (_authz, challenge) => { challenges.delete(challenge.token); },
  });
  writeFileSync(certFiles.key, key, { mode: 0o600 });
  writeFileSync(certFiles.cert, cert);
  installCertificate(key, Buffer.from(cert));
  console.log(`[copy-mx] STARTTLS on: new certificate for ${MX_HOSTNAME} valid until ${new Date(await certificateNotAfter(cert)).toISOString()}`);
}

const checkCertificate = () => ensureCertificate().catch((error) => {
  console.warn(`[copy-mx] certificate for ${MX_HOSTNAME} not obtained (${error?.message || error}); STARTTLS stays off and is tried again in 12 h`);
});

// Port 80 on this receiver's own address: the ACME challenge, and a health line.
http.createServer((req, res) => {
  const match = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url || '');
  const answer = match ? challenges.get(match[1]) : undefined;
  if (answer) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(answer);
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, starttls: !server.options.hideSTARTTLS }));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found\n');
}).listen(HTTP_PORT, '::', () => {
  void checkCertificate();
  setInterval(checkCertificate, RENEW_CHECK_MS).unref();
});
server.listen(PORT, '::', () => console.log(`[copy-mx] @${MAIL_DOMAIN} as ${MX_HOSTNAME} → ${BACKEND_URL}, listening on ${PORT}`));
