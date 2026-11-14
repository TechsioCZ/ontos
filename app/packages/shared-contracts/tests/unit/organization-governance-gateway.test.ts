import { Effect, Redacted, Result, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  GatewayOrganizationGovernanceReadSubjectSchema,
  decodeSupportedGatewayContextClaims,
} from '../../src/gateway-context.ts';
import { GatewayDelegationSubjectSchema } from '../../src/gateway-context-server.ts';

const principal = {
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:governance-contract',
  authenticationNamespaceId: 'test.native.staff',
  authMethod: 'session',
  legalEntityId: '50000000-0000-4000-8000-000000000002',
  principalId: '50000000-0000-4000-8000-000000000003',
  tenantId: '50000000-0000-4000-8000-000000000004',
};
const marker = {
  governanceLegalEntityId: principal.legalEntityId,
  principalId: principal.principalId,
  requestHash: 'a'.repeat(64),
  tenantId: principal.tenantId,
};
const claims = {
  act: { appId: 'privacy', buildMarker: 'privacy-native', principalId: '50000000-0000-4000-8000-000000000005' },
  aud: 'symmy-integration',
  compositionRevision: 'b'.repeat(64),
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'https://shell.example.test',
  jti: '50000000-0000-4000-8000-000000000006',
  organizationGovernanceRead: marker,
  principal,
  sub: principal.principalId,
  targetBuildMarker: 'symmy-native',
  ver: 6,
};

it.effect('binds version 6 to its original human, explicit namespace, governance company and fixed Read audience', () =>
  Effect.gen(function* organizationGovernanceClaims() {
    expect(yield* decodeSupportedGatewayContextClaims(claims)).toEqual(claims);
    for (const invalid of [
      { ...claims, act: { ...claims.act, appId: 'party-registry' } },
      { ...claims, act: { ...claims.act, principalId: principal.principalId } },
      { ...claims, aud: 'privacy' },
      { ...claims, exp: claims.exp + 1 },
      { ...claims, principal: Struct.omit(principal, ['authenticationNamespaceId']) },
      { ...claims, principal: { ...principal, legalEntityId: principal.tenantId } },
      { ...claims, principal: { ...principal, authMethod: 'system' } },
      { ...claims, organizationGovernanceRead: { ...marker, requestHash: 'unverified-selector' } },
      { ...claims, organizationGovernanceRead: { ...marker, entrypointKey: 'caller-selected-action' } },
      { ...claims, privacyDispatch: {} },
      { ...claims, workload: {} },
    ]) {
      expect(Result.isFailure(yield* Effect.result(decodeSupportedGatewayContextClaims(invalid)))).toBe(true);
    }
  }),
);

it.effect('publishes only a redacted source assertion and typed request checksum on the governance wire', () =>
  Effect.gen(function* organizationGovernanceWire() {
    const decode = Schema.decodeUnknownEffect(GatewayOrganizationGovernanceReadSubjectSchema, {
      onExcessProperty: 'error',
    });
    const wire = {
      _tag: 'OrganizationGovernanceRead',
      requestHash: marker.requestHash,
      sourceAssertion: 'actual-proof-token',
    };
    const decoded = yield* decode(wire);
    expect(Redacted.value(decoded.sourceAssertion)).toBe(wire.sourceAssertion);
    expect(decoded.requestHash).toBe(marker.requestHash);
    for (const invalid of [
      { ...wire, requestHash: 'bad-hash' },
      { ...wire, request: { arbitrary: 'payload' } },
      { ...wire, operationRequirementKey: 'invented-consumer-proof' },
      { ...wire, principal },
      { ...wire, sourceAssertion: '' },
    ]) {
      expect(Result.isFailure(yield* Effect.result(decode(invalid)))).toBe(true);
    }
    expect(
      Result.isFailure(
        yield* Effect.result(
          Schema.decodeUnknownEffect(GatewayDelegationSubjectSchema)({
            _tag: 'OrganizationGovernanceRead',
            requestHash: marker.requestHash,
            scope: principal,
          }),
        ),
      ),
    ).toBe(true);
  }),
);
