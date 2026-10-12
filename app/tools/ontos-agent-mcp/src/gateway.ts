import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig } from './config.ts';

/**
 * Shell API-key capability issuance.
 *
 * Endpoint: POST {ONTOS_SHELL_URL}/shell-super-app-api/auth/api-key/gateway-context
 *   - apiPrefix + path: packages/shared-contracts/src/gateway-context.ts:222 and :240-242
 *   - headers: x-api-key (gateway-context-api-key.ts:202-204), x-correlation-id (:34)
 *   - request body: GatewayContextRequestSchema, gateway-context.ts:128-133
 *   - response: GatewayContextResponseSchema, gateway-context.ts:135-144
 * Audience format: stable topology app ID, gateway-context.ts:29-33 (e.g. "siampark-work").
 * Assertion lifetime is 300 s (gateway-context.ts:20); cached here until 30 s before expiry.
 */
const GATEWAY_CONTEXT_PATH = '/shell-super-app-api/auth/api-key/gateway-context';
const REFRESH_MARGIN_MS = 30_000;

const AudienceSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);
const CompositionRevisionSchema = z.string().regex(/^[\da-f]{64}$/u);

export const GatewayContextRequestSchema = z.object({
  audience: AudienceSchema,
  compositionRevision: CompositionRevisionSchema,
  legalEntityId: z.string().uuid().optional(),
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
  /** Bearer assertion for the audience. Never log it. */
  readonly token: string;
  /** Path on the shell origin, e.g. /shell-super-app-api/module-api/<appId>/<build>/<appId>-api. */
  readonly apiBaseUrl: string;
  readonly compositionRevision: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

const cache = new Map<string, GatewayContext>();

function isFresh(context: GatewayContext, nowMs: number): boolean {
  return context.expiresAt * 1000 - REFRESH_MARGIN_MS > nowMs;
}

export async function getGatewayContext(audience: string): Promise<GatewayContext> {
  const cached = cache.get(audience);
  if (cached !== undefined && isFresh(cached, Date.now())) {
    return cached;
  }

  const config = getConfig();
  if (config.compositionRevision === undefined) {
    throw new Error('ONTOS_COMPOSITION_REVISION is required to request a gateway assertion (live release revision).');
  }

  const body = GatewayContextRequestSchema.parse({
    audience,
    compositionRevision: config.compositionRevision,
    ...(config.legalEntityId === undefined ? {} : { legalEntityId: config.legalEntityId }),
  });

  const response = await fetch(`${config.shellUrl}${GATEWAY_CONTEXT_PATH}`, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'x-correlation-id': randomUUID(),
    },
    method: 'POST',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway assertion for "${audience}" failed: HTTP ${response.status} ${text}`);
  }

  const parsed = GatewayContextResponseSchema.parse(await response.json());
  const context: GatewayContext = parsed;
  cache.set(audience, context);
  return context;
}

/** Returns only the bearer token for an audience. */
export async function getAssertion(audience: string): Promise<string> {
  return (await getGatewayContext(audience)).token;
}
