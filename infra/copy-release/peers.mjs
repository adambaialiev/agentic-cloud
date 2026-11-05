#!/usr/bin/env node
/**
 * Take away the WireGuard peers this box left in the test copy's Fly
 * organization (note #1008): `fly ssh` from here, as an upgrade --here
 * does, leaves one per run, named interactive-<hostname>-….
 *   FLY_API_TOKEN=… FLYCTL=… node infra/copy-release/peers.mjs <state file>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const { org } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const fly = process.env.FLYCTL || 'flyctl';
const listed = JSON.parse(execFileSync(fly, ['wireguard', 'list', org, '--json'], { encoding: 'utf8' }) || '[]');
const ours = listed.map((peer) => peer.Name ?? peer.name).filter((name) => typeof name === 'string' && name.startsWith(`interactive-${hostname()}-`));
for (const name of ours) execFileSync(fly, ['wireguard', 'remove', org, name], { stdio: 'ignore' });
if (ours.length) console.log(`   (${ours.length} WireGuard peer${ours.length === 1 ? '' : 's'} of this box removed)`);
