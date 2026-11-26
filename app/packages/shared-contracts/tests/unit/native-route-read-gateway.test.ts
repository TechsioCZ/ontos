import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  GatewayContextV2ClaimsSchema,
  GatewayContextV9ClaimsSchema,
  GatewayContextV10ClaimsSchema,
  SupportedGatewayContextClaimsSchema,
  SymmyGatewayRouteScopeSchema,
  decodeSupportedGatewayContextClaims,
} from '../../src/gateway-context.ts';

const principalId = '10000000-0000-4000-8000-000000000001';
const tenantId = '10000000-0000-4000-8000-000000000002';
const companyId = '10000000-0000-4000-8000-000000000003';
const originalPrincipalId = '10000000-0000-4000-8000-000000000004';
const runId = '10000000-0000-4000-8000-000000000005';
const claims = {
  aud: 'party-registry',
  compositionRevision: 'a'.repeat(64),
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'https://shell.example.test',
  jti: runId,
  principal: {
    authContextRef: `job:integration.symmy.route-read:run:${runId}`,
    authMethod: 'system',
    principalId,
    tenantId,
  },
  routeScope: {
    legalEntityId: companyId,
    nativeReadReceiver: {
      bindingIncarnation: runId,
      enrollmentLegalEntityId: companyId,
      originalPrincipalId,
      originalWorkloadBindingIncarnation: runId,
      originalWorkloadKey: 'integration.symmy-poll',
      workloadKey: 'party.registry.source-read',
    },
    operations: [{ entrypointKey: 'party.registry.api.source-profile-export', schemaVersion: '1' }],
    principalId,
    routeId: runId,
    routeKey: 'adminCustomers',
    routeRevision: '1',
    sourceRouteId: runId,
    sourceRouteRevision: '1',
    tenantId,
  },
  sub: principalId,
  targetBuildMarker: 'party-build',
  ver: 9,
};

it('decodes a native synchronous Read without any fabricated invocation or external identity namespace', () => {
  expect(Schema.is(GatewayContextV9ClaimsSchema)(claims)).toBe(true);
  expect(Schema.is(SupportedGatewayContextClaimsSchema)(claims)).toBe(true);
  expect('admissionInvocationId' in claims.routeScope.nativeReadReceiver).toBe(false);
});

it.effect('admits only the finite Symmy original workloads at issuance and both signed native wire versions', () =>
  Effect.gen(function* verifyFiniteNativeWorkloads() {
    for (const originalWorkloadKey of [
      'integration.symmy-admit',
      'integration.symmy-poll',
      'integration.customer-import-admit',
      'symmy.source-read',
      'party.registry.source-write',
      'integration.symmy-admit.extra',
      '',
    ]) {
      const routeScope = {
        ...claims.routeScope,
        nativeReadReceiver: {
          ...claims.routeScope.nativeReadReceiver,
          originalWorkloadKey,
          requestHash: 'b'.repeat(64),
        },
      };
      const allowed =
        originalWorkloadKey === 'integration.symmy-admit' || originalWorkloadKey === 'integration.symmy-poll';
      const issuedScope = yield* Effect.result(
        Schema.decodeUnknownEffect(SymmyGatewayRouteScopeSchema, { onExcessProperty: 'error' })(routeScope),
      );
      expect(Result.isSuccess(issuedScope)).toBe(allowed);
      for (const nativeClaims of [
        { ...claims, routeScope },
        {
          ...claims,
          act: {
            appId: 'symmy-integration',
            buildMarker: 'symmy-build',
            principalId: '10000000-0000-4000-8000-000000000006',
          },
          routeScope,
          ver: 10,
        },
      ]) {
        expect(Result.isSuccess(yield* Effect.result(decodeSupportedGatewayContextClaims(nativeClaims)))).toBe(allowed);
      }
    }
  }),
);

it('requires a distinct calling module on delegated native Reads without changing receiver or original identity rules', () => {
  const delegated = {
    ...claims,
    act: {
      appId: 'symmy-integration',
      buildMarker: 'symmy-build',
      principalId: '10000000-0000-4000-8000-000000000006',
    },
    routeScope: {
      ...claims.routeScope,
      nativeReadReceiver: { ...claims.routeScope.nativeReadReceiver, requestHash: 'b'.repeat(64) },
    },
    ver: 10,
  };
  expect(Schema.is(GatewayContextV10ClaimsSchema)(delegated)).toBe(true);
  const { act: _actor, ...withoutActor } = delegated;
  for (const invalid of [
    withoutActor,
    { ...delegated, routeScope: claims.routeScope },
    { ...delegated, act: { ...delegated.act, principalId } },
    { ...delegated, act: { ...delegated.act, principalId: originalPrincipalId } },
    { ...delegated, principal: { ...delegated.principal, authMethod: 'api_key' } },
    { ...delegated, principal: { ...delegated.principal, legalEntityId: companyId } },
    { ...delegated, exp: delegated.exp + 1 },
  ]) {
    expect(Schema.is(GatewayContextV10ClaimsSchema)(invalid)).toBe(false);
  }
});

it('rejects native Read evidence on old external claims, or a missing or mismatched receiver identity', () => {
  expect(
    Schema.is(GatewayContextV2ClaimsSchema)({
      ...claims,
      principal: {
        ...claims.principal,
        authBindingId: runId,
        authenticationNamespaceId: 'staff',
        authMethod: 'api_key',
        legalEntityId: companyId,
      },
      ver: 2,
    }),
  ).toBe(false);
  const { nativeReadReceiver: _receiver, ...routeScope } = claims.routeScope;
  for (const invalid of [
    { ...claims, routeScope },
    { ...claims, principal: { ...claims.principal, principalId: originalPrincipalId } },
    { ...claims, principal: { ...claims.principal, legalEntityId: companyId } },
    { ...claims, principal: { ...claims.principal, authenticationNamespaceId: 'staff' } },
    { ...claims, exp: claims.exp + 1 },
    { ...claims, routeScope: { ...claims.routeScope, principalId: originalPrincipalId } },
    {
      ...claims,
      routeScope: {
        ...claims.routeScope,
        nativeReadReceiver: {
          ...claims.routeScope.nativeReadReceiver,
          originalWorkloadKey: 'party.registry.source-write',
        },
      },
    },
  ]) {
    expect(Schema.is(GatewayContextV9ClaimsSchema)(invalid)).toBe(false);
  }
});
