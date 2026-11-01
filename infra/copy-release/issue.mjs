#!/usr/bin/env node
/**
 * Issue what a private-copy customer is given (note #811): an update key now,
 * a licence once stage 3's licence piece lands. Run by one of our agents,
 * with the signing key in the admins-only Secret COPY_SIGNING_KEY:
 *
 *   node infra/copy-release/issue.mjs update-key \
 *     --customer theirco --domain agents.theirco.com --until 2027-10-27
 *
 *   node infra/copy-release/issue.mjs licence \
 *     --customer theirco --domain agents.theirco.com --people 50 \
 *     [--starts 2026-11-01] [--ends 2027-10-31] [--updates-until 2027-10-31]
 *
 * A licence (note #814, as decided on note #810) names the copy's domain and
 * how many people may use it, and runs a year by default; the copy checks
 * it by itself and never calls us. Issue the update key with the same end.
 *
 * Prints the key or licence on stdout and nothing else there, so it can go
 * straight into the message to the customer's admin; what it covers goes to
 * stderr. Record every one issued in the customer list (company, domain,
 * people, dates).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicKeyFrom, signPayload, verifySigned } from './signed.mjs';

const CUSTOMER_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  console.error(`issue: ${message}`);
  process.exit(2);
}

const [kind, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 1) {
  if (!rest[i].startsWith('--')) fail(`unexpected argument ${rest[i]}`);
  flags[rest[i].slice(2)] = rest[i + 1];
  i += 1;
}

if (kind !== 'update-key' && kind !== 'licence') {
  fail('usage: issue.mjs update-key --customer <id> --domain <copy domain> --until <YYYY-MM-DD>\n'
    + '       issue.mjs licence --customer <id> --domain <copy domain> --people <n> [--starts <date>] [--ends <date>] [--updates-until <date>]');
}
const customer = String(flags.customer ?? '').toLowerCase();
const domain = String(flags.domain ?? '').toLowerCase();
const isDate = (value) => DATE_SHAPE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
if (!CUSTOMER_SHAPE.test(customer)) fail('--customer is a short lowercase id, like theirco');
if (!DOMAIN_SHAPE.test(domain)) fail('--domain is the copy\'s own domain, like agents.theirco.com');

const pem = process.env.COPY_SIGNING_KEY ?? '';
if (!pem.includes('PRIVATE KEY')) fail('COPY_SIGNING_KEY is not in the environment (an admins-only Secret, Platform room)');

let payload;
if (kind === 'update-key') {
  const until = String(flags.until ?? '');
  if (!isDate(until)) fail('--until is a date, YYYY-MM-DD');
  payload = { kind: 'update', id: randomUUID(), customer, domain, updatesUntil: until, issuedAt: new Date().toISOString() };
} else {
  const people = Number(flags.people);
  if (!Number.isInteger(people) || people < 1) fail('--people is how many people may use the copy, a whole number');
  const starts = String(flags.starts ?? new Date().toISOString().slice(0, 10));
  if (!isDate(starts)) fail('--starts is a date, YYYY-MM-DD');
  // A year by default (Adam, note #810): to the day before the same date next year.
  const yearOn = new Date(`${starts}T00:00:00Z`);
  yearOn.setUTCFullYear(yearOn.getUTCFullYear() + 1);
  const ends = String(flags.ends ?? new Date(yearOn.getTime() - 24 * 3600_000).toISOString().slice(0, 10));
  if (!isDate(ends) || ends < starts) fail('--ends is a date, YYYY-MM-DD, on or after --starts');
  const updatesUntil = String(flags['updates-until'] ?? ends);
  if (!isDate(updatesUntil)) fail('--updates-until is a date, YYYY-MM-DD');
  payload = { kind: 'licence', id: randomUUID(), customer, domain, people, starts, ends, updatesUntil, issuedAt: new Date().toISOString() };
}
const key = signPayload(payload, pem);
// Checked against the committed public key before it is printed: a key the
// update service would refuse must never reach a customer.
const committed = readFileSync(new URL('./signing-key.pub', import.meta.url), 'utf8');
if (!verifySigned(key, publicKeyFrom(committed))) fail('the signing key does not match infra/copy-release/signing-key.pub');
console.error(kind === 'update-key'
  ? `update key ${payload.id}: ${customer}, ${domain}, releases until ${payload.updatesUntil}`
  : `licence ${payload.id}: ${customer}, ${domain}, ${payload.people} people, ${payload.starts} to ${payload.ends}, updates until ${payload.updatesUntil}`);
process.stdout.write(`${key}\n`);
