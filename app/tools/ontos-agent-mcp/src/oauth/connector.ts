/**
 * Shell connector client (design §5.1 step 3). Describes the grant behind a verified access token. Results are cached
 * per grant id: successes for 30 s, failures for at most 5 s. Never log the token or the connector secret.
 */
import { randomUUID } from 'node:crypto';
import {
  CONNECTOR_KEY_HEADER,
  CONNECTOR_PATHS,
  ConnectionDescriptionSchema,
  ConnectionInactiveError,
  ConnectorUnavailableError,
} from './types.ts';
import type { ConnectionDescription, RsConfig, VerifiedAccessToken } from './types.ts';

export const DESCRIBE_SUCCESS_TTL_MS = 30_000;
export const DESCRIBE_FAILURE_TTL_MS = 5_000;
const MAX_CACHE_ENTRIES = 5_000;
const INACTIVE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);

/** Headers of every resource-server -> shell connector call. */
export const connectorHeaders = (connectorSecret: string, accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
  'content-type': 'application/json',
  [CONNECTOR_KEY_HEADER]: connectorSecret,
  'x-correlation-id': randomUUID(),
});

export interface DescriberOptions {
  readonly config: Pick<RsConfig, 'shellInternalUrl' | 'connectorSecret'>;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

type CacheEntry =
  | { readonly at: number; readonly ok: true; readonly description: ConnectionDescription }
  | { readonly at: number; readonly ok: false; readonly error: ConnectionInactiveError | ConnectorUnavailableError };

export const createConnectionDescriber = (options: DescriberOptions) => {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  const load = async (token: VerifiedAccessToken): Promise<ConnectionDescription> => {
    let response: Response;
    try {
      response = await fetchFn(`${options.config.shellInternalUrl}${CONNECTOR_PATHS.describe}`, {
        body: '{}',
        headers: connectorHeaders(options.config.connectorSecret, token.token),
        method: 'POST',
      });
    } catch (error) {
      throw new ConnectorUnavailableError(`connector/describe unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (INACTIVE_STATUSES.has(response.status)) {
      throw new ConnectionInactiveError(`connector/describe answered HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new ConnectorUnavailableError(`connector/describe answered HTTP ${response.status}`);
    }
    const parsed = ConnectionDescriptionSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new ConnectorUnavailableError('connector/describe answered an unexpected body');
    }
    if (parsed.data.grantId !== token.grantId) {
      throw new ConnectionInactiveError('connector/describe answered another grant');
    }
    return parsed.data;
  };

  return async (token: VerifiedAccessToken): Promise<ConnectionDescription> => {
    const cached = cache.get(token.grantId);
    if (cached !== undefined) {
      const age = now() - cached.at;
      if (cached.ok && age < DESCRIBE_SUCCESS_TTL_MS) {
        return cached.description;
      }
      if (!cached.ok && age < DESCRIBE_FAILURE_TTL_MS) {
        throw cached.error;
      }
    }
    if (cache.size > MAX_CACHE_ENTRIES) {
      cache.clear();
    }
    try {
      const description = await load(token);
      cache.set(token.grantId, { at: now(), description, ok: true });
      return description;
    } catch (error) {
      if (error instanceof ConnectionInactiveError || error instanceof ConnectorUnavailableError) {
        cache.set(token.grantId, { at: now(), error, ok: false });
      }
      throw error;
    }
  };
};
