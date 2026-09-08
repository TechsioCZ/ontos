import { readFileSync } from 'node:fs';

/** Every offending fragment is generator-side code inside an interpolation, not emitted text. */
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as Record<string, unknown>;

export const renderBoundary = (appId: string): string => `
export const audience = ${JSON.stringify(appId)};
export const flags = ${JSON.stringify(JSON.parse(String(manifest['flags'] ?? '{}')))};
export const registry = ${JSON.stringify(new URL(process.env.ONTOS_REGISTRY ?? 'https://example.invalid').href)};
`;
