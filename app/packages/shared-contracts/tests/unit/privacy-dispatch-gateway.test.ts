import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { GatewayPrivacyDispatchSubjectSchema, decodeSupportedGatewayContextClaims } from '../../src/gateway-context.ts';
import { GatewayDelegationSubjectSchema } from '../../src/gateway-context-server.ts';

const tenantId = '30000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const dispatchInvocationId = '30000000-0000-4000-8000-000000000004';
const privacyDispatch = {
  deliveryId: '30000000-0000-4000-8000-000000000005',
  dispatchInvocationId,
  domainEventId: '30000000-0000-4000-8000-000000000006',
  governanceLegalEntityId: legalEntityId,
  handoffHash: 'b'.repeat(64),
  measureId: 'native-measure',
  messageId: '30000000-0000-4000-8000-000000000007',
  operation: 'SymmyReceipt',
  principalId,
  requestHash: 'c'.repeat(64),
  sourceMode: 'dispatch',
  taskId: 'native-task',
  tenantId,
};
const claims = {
  act: { appId: 'privacy', buildMarker: 'privacy-native', principalId: '30000000-0000-4000-8000-000000000008' },
  aud: 'symmy-integration',
  compositionRevision: 'a'.repeat(64),
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'https://shell.example.test',
  jti: '30000000-0000-4000-8000-000000000009',
  principal: {
    authBindingId: '30000000-0000-4000-8000-000000000010',
    authContextRef: 'better-auth-session:native',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  },
  privacyDispatch,
  sub: principalId,
  targetBuildMarker: 'symmy-native',
  ver: 5,
};

it.effect('decodes the finite version 5 human claim without changing the original governance company', () =>
  Effect.gen(function* finitePrivacyClaimContract() {
    expect(yield* decodeSupportedGatewayContextClaims(claims)).toEqual(claims);
    for (const invalid of [
      { ...claims, aud: 'privacy' },
      { ...claims, exp: claims.exp + 1 },
      { ...claims, act: { ...claims.act, principalId } },
      { ...claims, principal: { ...claims.principal, legalEntityId: tenantId } },
      { ...claims, principal: { ...claims.principal, tenantId: legalEntityId } },
      { ...claims, principal: { ...claims.principal, authMethod: 'system' } },
      { ...claims, privacyDispatch: { ...privacyDispatch, operation: 'SymmyRetention' } },
      { ...claims, privacyDispatch: { ...privacyDispatch, requestHash: 'caller-chosen-nonhash' } },
      { ...claims, workload: {} },
    ]) {
      expect(Result.isFailure(yield* Effect.result(decodeSupportedGatewayContextClaims(invalid)))).toBe(true);
    }
  }),
);

it.effect('publishes only the finite dispatch request sources and bounded operation parameters', () =>
  Effect.gen(function* finitePrivacyWireContract() {
    const decode = Schema.decodeUnknownEffect(GatewayPrivacyDispatchSubjectSchema, { onExcessProperty: 'error' });
    const base = {
      _tag: 'PrivacyDispatch',
      operation: { _tag: 'SymmyReceipt', attempt: 1 },
      source: { _tag: 'Dispatch', dispatchInvocationId, legalEntityId, tenantId },
    };
    expect(Schema.is(GatewayPrivacyDispatchSubjectSchema)(yield* decode(base))).toBe(true);
    for (const invalid of [
      { ...base, operation: { _tag: 'ArbitraryAction' } },
      { ...base, operation: { _tag: 'SymmyReceipt', attempt: 0 } },
      { ...base, operation: { _tag: 'PrivacyOutcome', attempt: 1.5 } },
      { ...base, source: { _tag: 'Dispatch', dispatchInvocationId, tenantId } },
      { ...base, privacyDispatch },
      { ...base, source: { _tag: 'Assertion', scope: claims.principal } },
    ]) {
      expect(Result.isFailure(yield* Effect.result(decode(invalid)))).toBe(true);
    }
    expect(
      Result.isFailure(
        yield* Effect.result(
          Schema.decodeUnknownEffect(GatewayDelegationSubjectSchema)({
            ...base,
            source: { _tag: 'Worker', context: { tenantId } },
          }),
        ),
      ),
    ).toBe(true);
  }),
);
