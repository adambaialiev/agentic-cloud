import { describe, expect, it } from 'vitest';
import type { CorsOptions } from 'cors';
import {
  DEFAULT_CORS_ORIGIN,
  createCorsOptions,
  resolveAllowedCorsOrigins,
} from '../../config/cors.js';

async function resolveOrigin(options: CorsOptions, origin: string | undefined): Promise<unknown> {
  if (typeof options.origin !== 'function') {
    throw new Error('Expected a dynamic CORS origin resolver');
  }

  return new Promise((resolve, reject) => {
    options.origin(origin, (error, allowed) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(allowed);
    });
  });
}

describe('CORS config', () => {
  it('defaults to the local Vite origin when no env origin is configured', () => {
    expect(resolveAllowedCorsOrigins(undefined)).toEqual([DEFAULT_CORS_ORIGIN]);
  });

  it('parses comma-separated configured origins', () => {
    expect(resolveAllowedCorsOrigins(' https://one.example, https://two.example/ ')).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
  });

  it('allows both production app host variants when either one is configured', () => {
    expect(resolveAllowedCorsOrigins('https://agenticcloudcomputer.com')).toEqual([
      'https://agenticcloudcomputer.com',
      'https://www.agenticcloudcomputer.com',
    ]);

    expect(resolveAllowedCorsOrigins('https://www.agenticcloudcomputer.com')).toEqual([
      'https://www.agenticcloudcomputer.com',
      'https://agenticcloudcomputer.com',
    ]);
  });

  it('reflects allowed browser origins and rejects unknown origins', async () => {
    const options = createCorsOptions([
      'https://agenticcloudcomputer.com',
      'https://www.agenticcloudcomputer.com',
    ]);

    await expect(resolveOrigin(options, 'https://agenticcloudcomputer.com')).resolves.toBe(true);
    await expect(resolveOrigin(options, 'https://www.agenticcloudcomputer.com')).resolves.toBe(true);
    await expect(resolveOrigin(options, 'https://preview.example')).resolves.toBe(false);
  });
});
