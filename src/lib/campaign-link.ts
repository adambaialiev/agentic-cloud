import { useSyncExternalStore } from 'react';

/** Campaign fields accepted from public links. */
export interface CampaignParams {
  /** utm_source — which channel. */
  s?: string;
  /** utm_medium — what kind of channel. */
  m?: string;
  /** utm_campaign — which push. */
  c?: string;
  /** utm_term — keyword. */
  t?: string;
  /** utm_content — which creative or button. */
  k?: string;
  /** ref — the referring user, once referrals exist. */
  r?: string;
}

/** The inbound aliases accepted by the public site. */
const INBOUND_ALIASES: Record<string, keyof CampaignParams> = {
  utm_source: 's', source: 's', s: 's',
  utm_medium: 'm', medium: 'm', m: 'm',
  utm_campaign: 'c', campaign: 'c', c: 'c',
  utm_term: 't', term: 't', t: 't',
  utm_content: 'k', content: 'k', k: 'k',
  ref: 'r', referrer: 'r', r: 'r',
};

/** Reads campaign parameters from a browser query string. */
export function readInboundParams(search: string): CampaignParams {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const inbound: CampaignParams = {};
  for (const [rawKey, value] of params.entries()) {
    const key = INBOUND_ALIASES[rawKey.toLowerCase()];
    if (key && !inbound[key] && value) {
      inbound[key] = value;
    }
  }
  return inbound;
}

const INBOUND_SESSION_KEY = 'acc:inbound-campaign';

/**
 * Remembers the campaign for the current browser visit. A reader can move
 * between the product and an article without losing how they arrived.
 */
export function rememberInboundCampaign(search: string): string {
  const inbound = readInboundParams(search);

  if (inbound.s || inbound.r) {
    const canonical = new URLSearchParams(
      Object.entries(inbound).filter((entry): entry is [string, string] => Boolean(entry[1])),
    ).toString();
    try {
      sessionStorage.setItem(INBOUND_SESSION_KEY, canonical);
    } catch {
      // Storage may be disabled or full. The current page still keeps its
      // campaign; only carry-over to the next page is lost.
    }
    return canonical;
  }

  try {
    return sessionStorage.getItem(INBOUND_SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Cached per query string so React receives a stable external-store snapshot
 * until navigation changes the URL.
 */
let cachedCampaign: { search: string; value: string } | null = null;

function getInboundCampaign(): string {
  const search = window.location.search;
  if (!cachedCampaign || cachedCampaign.search !== search) {
    cachedCampaign = { search, value: rememberInboundCampaign(search) };
  }
  return cachedCampaign.value;
}

function getServerInboundCampaign(): string {
  return '';
}

function subscribeToInboundCampaign(): () => void {
  return () => {};
}

/** The campaign this browser visit arrived with, safe during prerendering. */
export function useInboundCampaign(): string {
  return useSyncExternalStore(
    subscribeToInboundCampaign,
    getInboundCampaign,
    getServerInboundCampaign,
  );
}

/**
 * Sends an article reader to the product page while preserving the campaign
 * that earned the visit and recording which page or button closed the hop.
 */
export function productPageUrl(placement: string, search?: string): string {
  const inbound = search ? readInboundParams(search) : {};
  const params = new URLSearchParams();

  if (inbound.s || inbound.r) {
    if (inbound.s) params.set('utm_source', inbound.s);
    if (inbound.m) params.set('utm_medium', inbound.m);
    if (inbound.c) params.set('utm_campaign', inbound.c);
    if (inbound.r) params.set('ref', inbound.r);
    params.set('utm_content', inbound.k ?? placement);
  } else {
    params.set('utm_source', 'site');
    params.set('utm_campaign', placement);
  }

  return `/product?${params.toString()}`;
}
