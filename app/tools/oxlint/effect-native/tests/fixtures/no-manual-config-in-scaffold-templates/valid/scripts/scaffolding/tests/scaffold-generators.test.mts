import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderActionPrincipalServer } from '../microvertical-action-boundary/scaffold.mts';

/**
 * Tests pin the *current* generator output, including the shapes the rule reports in the template
 * itself. Re-reporting them here would double-count a single defect, so tests are excluded.
 */
const legacySnapshot = `
  const rawJwks = environment['ONTOS_GATEWAY_PUBLIC_JWKS'];
  const parsed = JSON.parse(rawJwks);
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configurationError();
  }
  const key = parsed as Record<string, unknown>;
  const issuer = new URL(process.env.ONTOS_GATEWAY_ISSUER ?? '');
  return key['kty'];
`;

test('action boundary generator no longer emits the legacy JWK walk', () => {
  assert.ok(!renderActionPrincipalServer('contacts').includes(legacySnapshot.trim()));
});
