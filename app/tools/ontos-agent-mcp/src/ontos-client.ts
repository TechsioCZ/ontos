/**
 * OntOS vertical client: calls a vertical's actions and reads through the shell.
 *
 * URL patterns, derived from the sources (no live server was contacted):
 *
 * - Shell origin: ONTOS_SHELL_URL (default http://localhost:3020, .env.example:10).
 * - Audience = the vertical's stable app ID, e.g. "siampark-work"
 *   (packages/shared-contracts/src/gateway-context.ts:29-33; verticals/siampark-work/src/api/action-gateway.ts:10).
 * - Assertion response apiBaseUrl is the vertical's base path on the shell origin:
 *     /shell-super-app-api/module-api/<appId>/<buildMarker>/<appId>-api
 *   (apps/shell-super-app/api/auth/gateway-issuer.ts:256-258;
 *    packages/core-runtime/src/http/module-release-identity.ts:9-10).
 *   We never build this path ourselves: the build marker comes from the response.
 * - Action:  POST {shell}{apiBaseUrl}/{vertical}/actions/{actionSlug}
 *   (verticals/siampark-work/shared/apis/apply-command-action.ts:143 "/siampark-work/actions/apply-command";
 *    prefix at verticals/siampark-work/src/api/apply-command-action-client.ts:39).
 * - Records read: POST {shell}{apiBaseUrl}/reads/{readName}
 *   (verticals/siampark-work/shared/apis/records.ts:83 "/reads/records";
 *    prefix at verticals/siampark-work/src/api/records-client.ts:26). Query fields go in the JSON body.
 * - Headers: Authorization: Bearer <assertion> (packages/shared-contracts/src/operation-gateway.ts:51),
 *   x-ontos-composition-revision (packages/shared-contracts/src/client-runtime.ts:130), x-correlation-id.
 */
import { randomUUID } from 'node:crypto';
import { getConfig } from './config.ts';
import { getGatewayContext } from './gateway.ts';
import type { GatewayContext } from './gateway.ts';

function segment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`Invalid path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}

async function postJson(context: GatewayContext, path: string, body: unknown): Promise<unknown> {
  const { shellUrl } = getConfig();
  const response = await fetch(`${shellUrl}${context.apiBaseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${context.token}`,
      'content-type': 'application/json',
      'x-correlation-id': randomUUID(),
      'x-ontos-composition-revision': context.compositionRevision,
    },
    method: 'POST',
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OntOS request ${path} failed: HTTP ${response.status} ${text}`);
  }
  return text === '' ? null : (JSON.parse(text) as unknown);
}

/** Invokes a vertical action. The audience is the vertical ID. */
export async function callAction(vertical: string, actionSlug: string, payload: unknown): Promise<unknown> {
  const context = await getGatewayContext(vertical);
  return postJson(context, `/${segment(vertical)}/actions/${segment(actionSlug)}`, payload);
}

/** Reads a vertical's records endpoint. `readName` "records" maps to POST .../reads/records. */
export async function readRecords(vertical: string, readName: string, query: Record<string, string>): Promise<unknown> {
  const context = await getGatewayContext(vertical);
  return postJson(context, `/reads/${segment(readName)}`, query);
}
