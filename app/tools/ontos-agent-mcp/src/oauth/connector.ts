/**
 * Shell connector client (design §5.1 step 3). Describes the grant behind a verified access token on every MCP
 * request, without caching, so a revoked connection, a deactivated agent or narrowed module access applies to the very
 * next request (tools/list and ontos_whoami included). Never log the token or the connector secret.
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
}

export const createConnectionDescriber = (options: DescriberOptions) => {
  const fetchFn = options.fetchFn ?? fetch;

  return async (token: VerifiedAccessToken): Promise<ConnectionDescription> => {
    let response: Response;
    try {
      response = await fetchFn(`${options.config.shellInternalUrl}${CONNECTOR_PATHS.describe}`, {
        body: '{}',
        headers: connectorHeaders(options.config.connectorSecret, token.token),
        method: 'POST',
      });
    } catch (error) {
      throw new ConnectorUnavailableError(
        `connector/describe unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
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
};
