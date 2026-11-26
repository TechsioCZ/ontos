import { TrustedPrincipalContextSchema, loadCheckedActiveApplicationComposition } from '@app/core-runtime';
import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { SourceProcessingEligibilityResponseSchema } from '@app/privacy-contracts/source-processing-eligibility';
import { privacyOwnerDescriptors } from '@app/privacy/testing/owner-descriptors';
import { GatewayDelegatedContextRequestSchema, GatewayRegisteredAssertionSubjectSchema } from '@app/shared-contracts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { withModuleOperationExecution } from '../../../../packages/core-runtime/src/modules/module-operation-execution.ts';
import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import type { CommerceSourceProcessingRequest } from '../../src/integrations/source-processing-eligibility.ts';
import {
  CommerceSourceProcessingEligibility,
  commerceSourceProcessingEligibilityLive,
} from '../../src/integrations/source-processing-eligibility.ts';

import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const operationRequirementKey = 'commerce.customer-context.requirement.create-counterparty-profile-source-privacy';
const sourceAssertion = 'unit-only-source-assertion';
const evaluatedAt = '2026-11-23T12:00:00.000Z';
const tenantId = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const legalEntityId = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authContextRef: 'job:symmy:run:source-sync-evidence',
  authMethod: 'system',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId,
});
const { descriptor } = createCounterpartyPurchasingProfileAction;
const workload = Schema.decodeSync(RegisteredGatewayWorkloadSchema)({
  admissionInvocationId: '10000000-0000-4000-8000-000000000003',
  bindingIncarnation: '10000000-0000-4000-8000-000000000004',
  declarationKey: 'commerce.customer-context.counterparty-purchasing-profile.create',
  entrypointKey: descriptor.entrypoint.entrypointKey,
  jobKey: 'symmy-integration.apply',
  legalEntityId,
  legalEntityScope: 'required',
  originalOwnerBindingIncarnation: '10000000-0000-4000-8000-000000000005',
  originalPrincipalId: '10000000-0000-4000-8000-000000000006',
  originalWorkloadBindingIncarnation: '10000000-0000-4000-8000-000000000007',
  originalWorkloadKey: 'symmy-integration.customer-source-write',
  runReference: '10000000-0000-4000-8000-000000000008',
  schemaVersion: descriptor.schemaVersion,
  sourceAppId: 'symmy-integration',
  sourceBuildMarker: 'fixture-build',
  sourceMode: 'admission',
  workloadKey: 'commerce.customer-context.source-write',
});
const request = {
  operation: 'customer-profile-source.write',
  source: {
    issuer: 'symmy-akros',
    namespace: 'akros-erp',
    occurrenceId: 'source-occurrence',
    recordId: 'source-org',
    recordType: 'CUSTOMER',
    routeRef: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
  },
  target: { kind: 'PARTY', resourceId: '10000000-0000-4000-8000-000000000002' },
} satisfies CommerceSourceProcessingRequest;
const layers = Layer.mergeAll(
  commerceSourceProcessingEligibilityLive.pipe(Layer.provide(nodeCryptoLayer)),
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: 'true',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.invalid/shell-super-app-api',
    }),
  ),
  Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-customer-context': 'unit-only-module-credential' })),
  TestClock.layer(),
);
const positive = Schema.decodeSync(SourceProcessingEligibilityResponseSchema)({
  authorityIncarnation: 'akros-symmy-source-sync-v2',
  authorityRevision: 'v2',
  evaluatedAt,
  evidence: {
    _tag: 'SOURCE_SYNC_PROCESSING_POLICY',
    consumerModuleId: 'commerce.customer-context',
    dataUse: 'SOURCE_CUSTOMER_SYNC',
    legalEntityId,
    operation: request.operation,
    policyId: 'akros-symmy-source-sync-v2',
    policyRevision: 'v2',
    purpose: 'CUSTOMER_IMPORT',
    source: request.source,
    target: request.target,
    tenantId,
    trustedDecisionTime: evaluatedAt,
    validUntil: '2099-01-01T00:00:00.000Z',
  },
  outcome: 'ALLOWED',
});

// Run both real clients over a scripted Fetch peer; count only calls to the Privacy authority.
const privacyPeer = (decision: typeof SourceProcessingEligibilityResponseSchema.Type, compositionRevision: string) => {
  const reads: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const sent = new Request(input, init);
    const { pathname } = new URL(sent.url);
    if (pathname === '/shell-super-app-api/auth/delegated/gateway-context') {
      return sent
        .json()
        .then(Schema.decodeUnknownSync(GatewayDelegatedContextRequestSchema))
        .then((asked) => {
          expect(asked.audience).toBe('privacy');
          expect(asked.compositionRevision).toBe(compositionRevision);
          const subject = Schema.decodeUnknownSync(Schema.toType(GatewayRegisteredAssertionSubjectSchema))(
            asked.subject,
          );
          expect(subject.declarationKey).toBe('privacy.core.source-processing-eligibility.read');
          expect(subject.operationRequirementKey).toBe(operationRequirementKey);
          expect(Redacted.value(subject.sourceAssertion)).toBe(sourceAssertion);
          return Response.json({
            apiBaseUrl: '/privacy-api',
            compositionRevision,
            expiresAt: 2_000_000_000,
            token: 'unit-only-privacy-assertion',
          });
        });
    }
    if (pathname === '/privacy-api/reads/source-processing-eligibility') {
      reads.push(sent);
      return Promise.resolve(Response.json(Schema.encodeSync(SourceProcessingEligibilityResponseSchema)(decision)));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { fetch, reads };
};

const prepareCheck = Effect.fn('SourceProcessingEvidenceTest.prepareCheck')(function* prepareCheck(
  decision: typeof SourceProcessingEligibilityResponseSchema.Type,
) {
  yield* TestClock.setTime(Date.parse(evaluatedAt));
  const { applicationComposition } = yield* makeOwnerApplicationCompositionFixture({
    additionalOwners: [{ appId: 'privacy', descriptors: privacyOwnerDescriptors }],
    appId: 'commerce-customer-context',
    ownerRegistration: commerceCustomerContextRegistration,
  });
  const { catalog, snapshot } = yield* loadCheckedActiveApplicationComposition(applicationComposition);
  const { revision } = snapshot.composition;
  const scope = trustVerifiedGatewayPrincipalContext(
    { ...principal, correlationId: 'source-sync-evidence', legalEntityId },
    revision,
    { assertion: Redacted.make(sourceAssertion), audience: 'commerce-customer-context' },
    undefined,
    workload,
  );
  const { fetch, reads } = privacyPeer(decision, revision);
  const authority = yield* CommerceSourceProcessingEligibility;
  const check = (input: CommerceSourceProcessingRequest) =>
    withModuleOperationExecution(
      {
        loadCatalog: Effect.succeed(catalog),
        ownerRegistration: commerceCustomerContextRegistration,
        phase: 'execution',
        registration: createCounterpartyPurchasingProfileAction,
        revision,
        scope,
      },
      authority.check(scope, input, operationRequirementKey),
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  return { check, reads };
});

it.effect('returns the real fresh Privacy evidence instead of discarding the owner decision', () =>
  Effect.gen(function* returnsFreshEvidence() {
    const { check, reads } = yield* prepareCheck(positive);
    const decision = yield* check(request);
    expect(decision).toEqual(positive);
    expect(reads).toHaveLength(1);
  }).pipe(Effect.provide(layers)),
);
it.effect('selected source-sync path fails closed on native denial without another authority call', () =>
  Effect.gen(function* refusesPrivacyDenial() {
    const { check, reads } = yield* prepareCheck({ evaluatedAt, outcome: 'DENIED', reason: 'PROTECTED_MATERIAL' });
    const denied = yield* check(request).pipe(Effect.flip);
    expect(denied.code).toBe('DENIED');
    expect(reads).toHaveLength(1);
  }).pipe(Effect.provide(layers)),
);
it.effect('rejects an ALLOWED decision for a different target', () =>
  Effect.gen(function* refusesDifferentTarget() {
    const { check, reads } = yield* prepareCheck(positive);
    const denied = yield* check({ ...request, target: null }).pipe(Effect.flip);
    expect(denied.code).toBe('DENIED');
    expect(reads).toHaveLength(1);
  }).pipe(Effect.provide(layers)),
);
