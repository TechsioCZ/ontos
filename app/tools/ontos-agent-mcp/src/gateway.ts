import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getEndpoints } from './config.ts';
import { connectorHeaders } from './oauth/connector.ts';
import { CONNECTOR_PATHS, ConnectionInactiveError } from './oauth/types.ts';
import { currentPrincipal } from './session.ts';

/**
 * Shell gateway assertion issuance.
 *
 * API-key sessions (stdio): POST {ONTOS_SHELL_URL}/shell-super-app-api/auth/api-key/gateway-context
 * OAuth sessions (HTTP): POST {ONTOS_SHELL_URL}/shell-super-app-api/auth/connector/gateway-context with
 *   x-ontos-connector-key + Bearer user JWT, body {audience, compositionRevision}. The grant fixes the company.
 *
 *   - apiPrefix + path: packages/shared-contracts/src/gateway-context.ts:222 and :240-242
 *   - headers: x-api-key (gateway-context-api-key.ts:202-204), x-correlation-id (:34)
 *   - request body: GatewayContextRequestSchema, gateway-context.ts:128-133
 *   - response: GatewayContextResponseSchema, gateway-context.ts:135-144
 * Audience format: stable topology app ID, gateway-context.ts:29-33 (e.g. "siampark-work").
 * Assertions are single-use: each vertical records the redeemed `jti` (gateway_assertion_redemptions), so a second
 * request with the same token answers 401. Every vertical call therefore exchanges the key for a fresh assertion.
 */
const GATEWAY_CONTEXT_PATH = '/shell-super-app-api/auth/api-key/gateway-context';

const AudienceSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);
const CompositionRevisionSchema = z.string().regex(/^[\da-f]{64}$/u);
// Same shape zod's uuid() accepts; spelled out so the schema does not depend on zod's version-specific helper.
const UuidSchema = z.string().regex(/^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}$/u);

export const GatewayContextRequestSchema = z.object({
  audience: AudienceSchema,
  compositionRevision: CompositionRevisionSchema,
  legalEntityId: UuidSchema.optional(),
});

export const GatewayContextResponseSchema = z.object({
  apiBaseUrl: z
    .string()
    .min(1)
    .max(1000)
    .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u),
  compositionRevision: CompositionRevisionSchema,
  expiresAt: z.number().int().nonnegative(),
  token: z.string().min(1),
});

export interface GatewayContext {
  /** Path on the shell origin, e.g. /shell-super-app-api/module-api/<appId>/<build>/<appId>-api. */
  readonly apiBaseUrl: string;
  readonly compositionRevision: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
  /** Bearer assertion for the audience. Never log it. */
  readonly token: string;
}

const CompositionSchema = z.object({ composition: z.object({ revision: CompositionRevisionSchema }) });

/** Revision learned from the composition publisher; replaces a missing or stale ONTOS_COMPOSITION_REVISION. */
let liveRevision: string | undefined;

const fetchActiveRevision = async (): Promise<string | undefined> => {
  const { compositionUrl } = getEndpoints();
  try {
    const response = await fetch(compositionUrl);
    if (!response.ok) {
      return undefined;
    }
    liveRevision = CompositionSchema.parse(await response.json()).composition.revision;
    process.stderr.write(`composition revision ${liveRevision.slice(0, 12)}… from ${compositionUrl}\n`);
    return liveRevision;
  } catch {
    return undefined;
  }
};

const requestGatewayContext = async (audience: string, compositionRevision: string): Promise<Response> => {
  const { shellUrl } = getEndpoints();
  // The active principal (session.ts): the HTTP session's bearer token or the stdio environment key.
  const principal = currentPrincipal();
  if (principal.kind === 'oauth_connection') {
    // Design §5.1 step 5: the user JWT goes only to the shell connector; the grant fixes the company.
    return await fetch(`${shellUrl}${CONNECTOR_PATHS.gatewayContext}`, {
      body: JSON.stringify({ audience, compositionRevision }),
      headers: connectorHeaders(principal.connectorSecret, principal.accessToken),
      method: 'POST',
    });
  }
  const body = GatewayContextRequestSchema.parse({
    audience,
    compositionRevision,
    legalEntityId: principal.legalEntityId,
  });
  return await fetch(`${shellUrl}${GATEWAY_CONTEXT_PATH}`, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-api-key': principal.apiKey,
      'x-correlation-id': randomUUID(),
    },
    method: 'POST',
  });
};

/**
 * Issues a fresh single-use assertion for one vertical call. Never cache the result.
 * The revision comes from ONTOS_COMPOSITION_REVISION, else from the composition publisher. When the shell answers
 * 409 (reload required: the stack was rebuilt), the live revision is fetched once and the request retried.
 */
export const getGatewayContext = async (audience: string): Promise<GatewayContext> => {
  const config = getEndpoints();
  const revision = liveRevision ?? config.compositionRevision ?? (await fetchActiveRevision());
  if (revision === undefined) {
    throw new Error(
      `No composition revision: set ONTOS_COMPOSITION_REVISION or start the composition publisher (${config.compositionUrl}).`,
    );
  }

  let response = await requestGatewayContext(audience, revision);
  if (response.status === 409) {
    const refreshed = await fetchActiveRevision();
    if (refreshed !== undefined && refreshed !== revision) {
      response = await requestGatewayContext(audience, refreshed);
    }
  }

  if (!response.ok) {
    if (response.status === 401 && currentPrincipal().kind === 'oauth_connection') {
      throw new ConnectionInactiveError(`Gateway assertion for "${audience}" refused: HTTP 401`);
    }
    const text = await response.text();
    throw new Error(`Gateway assertion for "${audience}" failed: HTTP ${response.status} ${text}`);
  }

  const context: GatewayContext = GatewayContextResponseSchema.parse(await response.json());
  return context;
};

/** Returns only the bearer token for an audience. */
export const getAssertion = async (audience: string): Promise<string> => {
  const context = await getGatewayContext(audience);
  return context.token;
};
