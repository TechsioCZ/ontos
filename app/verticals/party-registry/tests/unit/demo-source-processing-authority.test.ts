import {
  SourceProcessingEligibilityRequestSchema,
  SourceProcessingEligibilityResponseSchema,
} from '@app/privacy/api/source-processing-eligibility';
import { ConfigProvider, DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  authorizePartyClientSourceReferenceWithProjection,
  PartyClientSourcePrivacy,
} from '../../src/services/party-client-source-evidence.service.ts';
import { demoPartySourceProcessingAuthority } from '../../src/services/party-client-source-privacy.service.ts';

const tenantId = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const legalEntityId = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const scope = {
  authMethod: 'system',
  legalEntityId,
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const source = {
  issuer: 'symmy-akros',
  namespace: 'akros-erp',
  occurrenceId: 'offline-organization-occurrence',
  recordId: 'offline-organization',
  recordType: 'CUSTOMER',
  routeRef: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
};
const request = Schema.decodeUnknownSync(SourceProcessingEligibilityRequestSchema)({
  consumerModuleId: 'party.registry',
  operation: 'CREATE',
  source,
  target: null,
});
const evidence = {
  _tag: 'DEMO_TEST_DATA_SOURCE_POLICY',
  consumerModuleId: 'party.registry',
  dataUse: 'DEMO_TEST_DATA_ONLY',
  legalEntityId,
  operation: 'CREATE',
  policyId: 'akros-symmy-demo-test-data',
  policyRevision: 'v1',
  purpose: 'DEMO_CUSTOMER_IMPORT_TESTING',
  source,
  target: null,
  tenantId,
  trustedDecisionTime: '2026-11-23T12:00:00.000Z',
  validUntil: '2026-11-24T00:00:00.000Z',
} as const;
const result = Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
  authorityIncarnation: evidence.policyId,
  authorityRevision: evidence.policyRevision,
  evaluatedAt: evidence.trustedDecisionTime,
  evidence,
  outcome: 'ALLOWED',
});
const now = DateTime.makeUnsafe('2026-11-23T12:00:01.000Z');
const select = (response: typeof SourceProcessingEligibilityResponseSchema.Type = result) =>
  demoPartySourceProcessingAuthority({ scope, request, result: response, now });
type DemoEvidence = Extract<
  Extract<typeof SourceProcessingEligibilityResponseSchema.Type, { readonly outcome: 'ALLOWED' }>['evidence'],
  { readonly _tag: 'DEMO_TEST_DATA_SOURCE_POLICY' }
>;

it('retains native synthetic-processing evidence without claiming a business-only exemption', () => {
  expect(select()).toEqual({ _tag: 'DEMO_TEST_DATA_PROCESSING_ALLOWED', evidence });
});

it('refuses stale, mismatched or denied testing authority rather than using a business-only fallback', () => {
  const changed = (patch: Partial<DemoEvidence>) =>
    Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
      ...result,
      evidence: { ...evidence, ...patch },
    });
  const decisions = [
    changed({ operation: 'MATCH' }),
    changed({ source: { ...source, recordId: 'another-record' } }),
    changed({ source: { ...source, occurrenceId: 'another-occurrence' } }),
    changed({ validUntil: '2026-11-23T11:59:59.000Z' }),
    Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
      ...result,
      authorityIncarnation: 'another-policy',
    }),
    Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
      ...result,
      authorityRevision: 'another-revision',
    }),
    Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
      evaluatedAt: evidence.trustedDecisionTime,
      outcome: 'DENIED',
      reason: 'AUTHORITY_NOT_CURRENT',
    }),
  ];
  for (const decision of decisions) expect(select(decision)).toBe('DENIED');
  expect(
    demoPartySourceProcessingAuthority({
      scope: { ...scope, legalEntityId: '10000000-0000-4000-8000-000000000002' },
      request,
      result,
      now,
    }),
  ).toBe('DENIED');
});

it.effect('keeps the selected testing authority distinct through source enrollment authorization', () =>
  Effect.gen(function* sourceAuthorization() {
    const decision = select();
    if (decision === 'DENIED') return yield* Effect.die('Native testing authority fixture was rejected');
    const authorization = yield* authorizePartyClientSourceReferenceWithProjection(
      {
        occurrenceId: source.occurrenceId,
        recordId: source.recordId,
        source: {
          issuer: source.issuer,
          namespace: source.namespace,
          recordType: source.recordType,
          routeRef: source.routeRef,
        },
      },
      scope,
      { operation: 'CREATE' },
    ).pipe(
      Effect.provideService(PartyClientSourcePrivacy, {
        checkImport: () => Effect.succeed(decision),
      }),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: JSON.stringify([
            {
              ...scope,
              issuer: source.issuer,
              namespace: source.namespace,
              recordType: source.recordType,
              routeRef: source.routeRef,
            },
          ]),
        }),
      ),
    );
    expect(authorization).toEqual({ kind: 'demo_test_data', evidence });
    expect(authorization.kind).not.toBe('organization_business');
  }),
);
