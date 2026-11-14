import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OAuthAuthenticationObservationSchema,
  oauthAuthenticationAuditRow,
} from '../../src/auth/oauth-authentication-audit-contract.ts';
import type { OAuthAuthenticationObservation } from '../../src/auth/oauth-authentication-audit-contract.ts';

const grant = {
  clientId: 'https://client.example/metadata',
  clientName: 'Connector',
  grantId: '00000000-0000-4000-8000-000000000001',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
  userPrincipalId: '00000000-0000-4000-8000-000000000004',
};
const reuse = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authMethod: 'oauth_refresh_token',
  eventType: 'oauth.token.refresh_reuse',
  evidence: {
    clientId: 'https://actual-token-client.example',
    grantStatusBefore: 'revoked',
    refreshTokenId: 'retained-token-row-id',
  },
  grant,
  outcome: 'denied',
  outcomeCode: 'refresh_reuse',
  principalId: grant.userPrincipalId,
} satisfies OAuthAuthenticationObservation;

it.effect('refresh denials need retained server grant facts, not admission or a live binding', () =>
  Effect.gen(function* refreshDenial() {
    const row = yield* oauthAuthenticationAuditRow(reuse);
    expect(row).toMatchObject({
      auditProfile: 'sensitive',
      authBindingId: reuse.authBindingId,
      authMethod: 'oauth_refresh_token',
      eventType: 'oauth.token.refresh_reuse',
      legalEntityId: grant.legalEntityId,
      outcome: 'denied',
      outcomeCode: 'refresh_reuse',
      outcomeStage: 'authn',
      principalId: grant.userPrincipalId,
      tenantId: grant.tenantId,
    });
    expect(row.evidenceJson).toMatchObject({
      clientId: reuse.evidence.clientId,
      clientName: grant.clientName,
      grantId: grant.grantId,
      grantStatusBefore: 'revoked',
      userPrincipalId: grant.userPrincipalId,
    });
  }),
);

it('rejects arbitrary evidence, token material, event names and changed security outcomes', () => {
  const decode = Schema.decodeUnknownOption(OAuthAuthenticationObservationSchema, { onExcessProperty: 'error' });
  expect(Option.isSome(decode(reuse))).toBe(true);
  expect(
    Option.isSome(decode({ ...reuse, evidence: { ...reuse.evidence, refreshToken: 'must-not-be-audited' } })),
  ).toBe(false);
  expect(Option.isSome(decode({ ...reuse, outcome: 'succeeded' }))).toBe(false);
  expect(Option.isSome(decode({ ...reuse, eventType: 'arbitrary.audit.write' }))).toBe(false);
  expect(Option.isSome(decode({ ...reuse, outcomeCode: 'arbitrary' }))).toBe(false);
});

it.effect('preserves request attribution without generating a principal or synthetic correlation identity', () =>
  Effect.gen(function* requestAttribution() {
    const row = yield* oauthAuthenticationAuditRow({
      ...reuse,
      request: {
        authContextRef: 'better-auth-session:real',
        correlationId: 'ingress-correlation',
        impersonatedByPrincipalId: grant.userPrincipalId,
        requestId: 'ingress-request',
        traceId: 'ingress-trace',
      },
    });
    expect(row.authContextRef).toBe('better-auth-session:real');
    expect(row.impersonatedByPrincipalId).toBe(grant.userPrincipalId);
    expect(row.evidenceJson).toMatchObject({
      correlationId: 'ingress-correlation',
      requestId: 'ingress-request',
      traceId: 'ingress-trace',
    });
    const background = yield* oauthAuthenticationAuditRow(reuse);
    expect(background.authContextRef).toBeUndefined();
    expect(background.evidenceJson).not.toHaveProperty('correlationId');
  }),
);
