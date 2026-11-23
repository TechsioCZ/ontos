import { NodeCrypto } from '@effect/platform-node';
import { rstest } from '@rstest/core';
import { ConfigProvider, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SourceProcessingEligibilityResponseSchema } from '@app/privacy/api/source-processing-eligibility';
import {
  CommerceSourceProcessingEligibility,
  commerceSourceProcessingEligibilityLive,
} from '../../src/integrations/source-processing-eligibility.ts';

const relay = rstest.hoisted(() => ({ response: undefined as unknown, calls: 0 }));
rstest.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: () =>
    Effect.succeed({
      authorization: 'Bearer unit-only-not-a-credential',
      apiBaseUrl: 'https://privacy.invalid/',
      compositionRevision: 'a'.repeat(64),
    }),
}));
rstest.mock('@app/privacy/api/source-processing-eligibility/client', () => ({
  executeSourceProcessingEligibilityWithAuthorization: () => {
    relay.calls++;
    return Effect.succeed(relay.response);
  },
}));
const scope = {
  authMethod: 'system' as const,
  correlationId: 'testing-evidence',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
};
const request = {
  operation: 'customer-profile-source.write',
  source: {
    issuer: 'symmy-akros',
    namespace: 'akros-erp',
    routeRef: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
    recordType: 'CUSTOMER',
    recordId: 'synthetic-org',
    occurrenceId: 'synthetic-occurrence',
  },
  target: { kind: 'PARTY' as const, resourceId: '10000000-0000-4000-8000-000000000002' },
};
const layers = commerceSourceProcessingEligibilityLive.pipe(Layer.provide(NodeCrypto.layer));
const config = ConfigProvider.fromUnknown({ ONTOS_PRIVACY_DEMO_SOURCE_PROCESSING_ENABLED: 'true' });
const positive = (at: string) =>
  Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
    outcome: 'ALLOWED',
    authorityIncarnation: 'akros-symmy-demo-test-data',
    authorityRevision: 'v1',
    evaluatedAt: at,
    evidence: {
      _tag: 'DEMO_TEST_DATA_SOURCE_POLICY',
      dataUse: 'DEMO_TEST_DATA_ONLY',
      purpose: 'DEMO_CUSTOMER_IMPORT_TESTING',
      tenantId: scope.tenantId,
      legalEntityId: scope.legalEntityId,
      policyId: 'akros-symmy-demo-test-data',
      policyRevision: 'v1',
      consumerModuleId: 'commerce.customer-context',
      operation: request.operation,
      source: request.source,
      target: request.target,
      trustedDecisionTime: at,
      validUntil: '2099-01-01T00:00:00.000Z',
    },
  });

it.effect('returns the real fresh Privacy evidence instead of discarding the owner decision', () =>
  Effect.gen(function* () {
    relay.response = positive(DateTime.formatIso(yield* DateTime.now));
    relay.calls = 0;
    const authority = yield* CommerceSourceProcessingEligibility;
    const decision = yield* authority.check(
      scope,
      request,
      'commerce.customer-context.requirement.create-counterparty-profile-source-privacy',
    );
    expect(decision).toEqual(relay.response);
    expect(relay.calls).toBe(1);
  }).pipe(Effect.provide(layers), Effect.provideService(ConfigProvider.ConfigProvider, config)),
);
it.effect('selected testing path fails closed on native denial without another authority call', () =>
  Effect.gen(function* () {
    relay.response = {
      outcome: 'DENIED',
      reason: 'PROTECTED_MATERIAL',
      evaluatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    relay.calls = 0;
    const authority = yield* CommerceSourceProcessingEligibility;
    const denied = yield* authority.check(scope, request, 'unit-required-provider').pipe(Effect.flip);
    expect(denied.code).toBe('DENIED');
    expect(relay.calls).toBe(1);
  }).pipe(Effect.provide(layers), Effect.provideService(ConfigProvider.ConfigProvider, config)),
);
it.effect('rejects an ALLOWED decision for a different target', () =>
  Effect.gen(function* () {
    relay.response = positive(DateTime.formatIso(yield* DateTime.now));
    const authority = yield* CommerceSourceProcessingEligibility;
    const denied = yield* authority
      .check(scope, { ...request, target: null }, 'unit-required-provider')
      .pipe(Effect.flip);
    expect(denied.code).toBe('DENIED');
  }).pipe(Effect.provide(layers), Effect.provideService(ConfigProvider.ConfigProvider, config)),
);
