// `generateKey` / `importKey` are ordinary application identifiers (cache keys, idempotency keys) and
// `scripts/**` is ~200 files of templates. Inside a template they may only match real WebCrypto access
// (`subtle.importKey(`), never a bare call or a method on an unrelated receiver.
export const renderCacheHelpers = (moduleId: string): string => `
import { generateKey, importKey } from './cache-keys.ts';

export const cacheKeyFor = (tenantId: string, id: string): string =>
  generateKey('${moduleId}', tenantId, id);

export const restoreCacheKey = (serialized: string): string => importKey(serialized);

export const viaClient = (client: CacheClient): string => client.generateKey('${moduleId}');
`;
