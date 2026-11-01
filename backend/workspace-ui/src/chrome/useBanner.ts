import { useContext } from 'react';
import { BannerContext, type BannerValue } from './banner-context.js';

export function useBanner(): BannerValue {
  const value = useContext(BannerContext);
  if (!value) throw new Error('useBanner() needs a BannerProvider above it');
  return value;
}
