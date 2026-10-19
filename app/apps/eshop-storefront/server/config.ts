// Server-only configuration. The storefront API key never leaves this process.
import { existsSync, readFileSync } from 'node:fs';

/** app/.env.demo.local, resolved from this file: server -> eshop-storefront -> apps -> app. */
const DEMO_ENV_FILE = new URL('../../../.env.demo.local', import.meta.url);

/** Kavárna Doma s.r.o. — the fixed e-shop legal entity of the sales demo. */
export const ESHOP_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000023';

export interface StorefrontConfig {
  readonly apiKey: string | undefined;
  readonly compositionRevision: string | undefined;
  readonly compositionUrl: string;
  readonly legalEntityId: string;
  readonly merchandiseAudience: string;
  readonly port: number;
  readonly shellUrl: string;
}

const unquote = (value: string): string => {
  const quote = value.at(0);
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
};

const parseEnvFile = (text: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = body.indexOf('=');
    if (separator <= 0) continue;
    values[body.slice(0, separator).trim()] = unquote(body.slice(separator + 1).trim());
  }
  return values;
};

/** Re-read on every call so a key written by reset-permissions after start-up is picked up without a restart. */
export const getConfig = (): StorefrontConfig => {
  const file = existsSync(DEMO_ENV_FILE) ? parseEnvFile(readFileSync(DEMO_ENV_FILE, 'utf-8')) : {};
  const read = (key: string): string | undefined => {
    const value = (process.env[key] ?? file[key])?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  return {
    apiKey: read('ONTOS_STOREFRONT_API_KEY'),
    compositionRevision: read('ONTOS_COMPOSITION_REVISION'),
    compositionUrl: read('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL') ?? 'http://127.0.0.1:3041/active',
    legalEntityId: read('ONTOS_STOREFRONT_LEGAL_ENTITY_ID') ?? ESHOP_LEGAL_ENTITY_ID,
    merchandiseAudience: read('ONTOS_STOREFRONT_AUDIENCE') ?? 'merchandise',
    port: Number(read('ESHOP_STOREFRONT_PORT') ?? 3060),
    shellUrl: (read('ONTOS_SHELL_URL') ?? 'http://localhost:3020').replace(/\/+$/u, ''),
  };
};
