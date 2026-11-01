import { beforeEach, describe, expect, it } from 'vitest';
import {
  productPageUrl,
  readInboundParams,
  rememberInboundCampaign,
} from './campaign-link';

describe('readInboundParams', () => {
  it('reads full UTM names and their short aliases alike', () => {
    expect(readInboundParams('?utm_source=hn&utm_medium=social&utm_campaign=showhn'))
      .toEqual({ s: 'hn', m: 'social', c: 'showhn' });
    expect(readInboundParams('s=x&m=social&c=demo')).toEqual({ s: 'x', m: 'social', c: 'demo' });
  });

  it('ignores unrelated query parameters', () => {
    expect(readInboundParams('?_ptxn=txn_123&gclid=abc')).toEqual({});
  });
});

describe('rememberInboundCampaign', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('carries the campaign to a page that lost the query string', () => {
    rememberInboundCampaign('?utm_source=hn&utm_campaign=showhn');

    expect(readInboundParams(rememberInboundCampaign('')))
      .toEqual({ s: 'hn', c: 'showhn' });
  });

  it('lets a new campaign replace the remembered one', () => {
    rememberInboundCampaign('?utm_source=hn');
    rememberInboundCampaign('?utm_source=producthunt');

    expect(readInboundParams(rememberInboundCampaign('')).s).toBe('producthunt');
  });

  it('remembers nothing when there was no campaign to remember', () => {
    expect(rememberInboundCampaign('?_ptxn=txn_123')).toBe('');
  });

  it('survives session storage being unavailable', () => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('storage disabled');
    };
    try {
      expect(() => rememberInboundCampaign('')).not.toThrow();
      expect(rememberInboundCampaign('')).toBe('');
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });
});

describe('productPageUrl', () => {
  it('attributes a direct product link to its placement', () => {
    expect(productPageUrl('article_header'))
      .toBe('/product?utm_source=site&utm_campaign=article_header');
  });

  it('preserves the inbound campaign and records the closing placement', () => {
    expect(productPageUrl(
      'article_header',
      '?utm_source=hn&utm_medium=social&utm_campaign=launch',
    )).toBe('/product?utm_source=hn&utm_medium=social&utm_campaign=launch&utm_content=article_header');
  });

  it('preserves referrals without inventing a source', () => {
    expect(productPageUrl('article_header', '?ref=user_42'))
      .toBe('/product?ref=user_42&utm_content=article_header');
  });
});
