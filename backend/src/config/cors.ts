import type { CorsOptions } from 'cors';

export const DEFAULT_CORS_ORIGIN = 'http://localhost:5175';

const PRODUCTION_APP_ORIGINS = [
  'https://agenticcloudcomputer.com',
  'https://www.agenticcloudcomputer.com',
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function parseCorsOrigins(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function productionCompanionOrigins(origins: readonly string[]): string[] {
  return origins.some((origin) => PRODUCTION_APP_ORIGINS.includes(origin))
    ? PRODUCTION_APP_ORIGINS
    : [];
}

export function resolveAllowedCorsOrigins(configuredCorsOrigin?: string): string[] {
  const configuredOrigins = parseCorsOrigins(configuredCorsOrigin);
  const baseOrigins = configuredOrigins.length > 0 ? configuredOrigins : [DEFAULT_CORS_ORIGIN];

  return unique([
    ...baseOrigins,
    ...productionCompanionOrigins(baseOrigins),
  ]);
}

export function createCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
  };
}
