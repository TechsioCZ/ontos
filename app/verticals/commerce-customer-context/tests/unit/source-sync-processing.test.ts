import type { OperationalScope } from '@app/core-runtime';
import { SourceProcessingEligibilityResponseSchema } from '@app/privacy/api/source-processing-eligibility';
import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  requireSourceSyncProcessingPermit,
  sourceSyncProcessingSelected,
  acquireSourceSyncProcessingPermit,
} from '../../src/integrations/source-sync-processing.ts';
import type { CommerceSourceProcessingRequest } from '../../src/integrations/source-processing-eligibility.ts';
const scope: OperationalScope = {
  authMethod: 'system',
  correlationId: 'source-sync-unit',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
};
const now = '2026-11-23T12:00:00.000Z';
const request: CommerceSourceProcessingRequest = {
  operation: 'customer-profile-source.read',
  source: {
    issuer: 'symmy-akros',
    namespace: 'akros-erp',
    routeRef: '5158ef08-7315-57e1-a9ed-b0fef8cd9ac1',
    recordType: 'CUSTOMER',
    recordId: 'source-org',
    occurrenceId: 'source-import-1',
  },
  target: { kind: 'COUNTERPARTY_PURCHASING_PROFILE', resourceId: '10000000-0000-4000-8000-000000000002' },
};
const evidence = {
  _tag: 'SOURCE_SYNC_PROCESSING_POLICY',
  tenantId: scope.tenantId,
  legalEntityId: scope.legalEntityId,
  consumerModuleId: 'commerce.customer-context',
  operation: request.operation,
  source: request.source,
  target: request.target,
  policyId: 'akros-symmy-source-sync-v2',
  policyRevision: 'v2',
  dataUse: 'SOURCE_CUSTOMER_SYNC',
  purpose: 'CUSTOMER_IMPORT',
  trustedDecisionTime: now,
  validUntil: '2026-11-24T00:00:00.000Z',
};
const response = (change: Readonly<Record<string, unknown>> = {}, top: Readonly<Record<string, unknown>> = {}) =>
  Schema.decodeUnknownSync(SourceProcessingEligibilityResponseSchema)({
    outcome: 'ALLOWED',
    authorityIncarnation: evidence.policyId,
    authorityRevision: 'v2',
    evaluatedAt: now,
    evidence: { ...evidence, ...change },
    ...top,
  });
it.effect('retains exact native source-sync evidence without business classification', () =>
  Effect.gen(function* () {
    const permit = yield* requireSourceSyncProcessingPermit(scope, request, response(), now);
    expect(permit._tag).toBe('SOURCE_SYNC_PROCESSING_POLICY');
    expect('classification' in permit).toBe(false);
  }),
);
for (const [name, change] of Object.entries({
  consumer: { consumerModuleId: 'party.registry' },
  operation: { operation: 'customer-profile-source.write' },
  source: { source: { ...request.source, recordId: 'different-record' } },
  occurrence: { source: { ...request.source, occurrenceId: 'different-import' } },
  target: { target: null },
  expired: { validUntil: now },
  decisionTime: { trustedDecisionTime: '2026-11-23T11:59:59.000Z' },
})) {
  it.effect(`rejects mismatched ${name}`, () =>
    Effect.gen(function* () {
      expect(
        (yield* requireSourceSyncProcessingPermit(scope, request, response(change), now).pipe(Effect.flip)).code,
      ).toBe('DENIED');
    }),
  );
}
it.effect('does not replace a native denial with business-only authority', () =>
  Effect.gen(function* () {
    expect(
      (yield* requireSourceSyncProcessingPermit(
        scope,
        request,
        { outcome: 'DENIED', evaluatedAt: now, reason: 'PROTECTED_MATERIAL' },
        now,
      ).pipe(Effect.flip)).code,
    ).toBe('DENIED');
  }),
);
it.effect('refuses retained stale authority', () =>
  Effect.gen(function* () {
    expect(
      (yield* requireSourceSyncProcessingPermit(
        scope,
        request,
        response(
          {},
          {
            evaluatedAt: '2026-11-23T11:58:00.000Z',
            evidence: { ...evidence, trustedDecisionTime: '2026-11-23T11:58:00.000Z' },
          },
        ),
        now,
      ).pipe(Effect.flip)).code,
    ).toBe('DENIED');
  }),
);
for (const [name, values, selected] of [
  ['unset', {}, false],
  ['off', { ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: 'false' }, false],
  ['on', { ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: 'true' }, true],
] as const) {
  it.effect(`explicit mode selection ${name}`, () =>
    Effect.gen(function* () {
      expect(
        yield* sourceSyncProcessingSelected.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
        ),
      ).toBe(selected);
    }),
  );
}
it.effect('invalid mode fails closed', () =>
  Effect.gen(function* () {
    expect(
      (yield* sourceSyncProcessingSelected.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: 'invalid' }),
        ),
        Effect.flip,
      )).code,
    ).toBe('UNAVAILABLE');
  }),
);

for (const [name, alteredScope] of [
  ['tenant', { ...scope, tenantId: '10000000-0000-4000-8000-000000000003' }],
  ['company', { ...scope, legalEntityId: '10000000-0000-4000-8000-000000000004' }],
] as const) {
  it.effect(`rejects foreign ${name}`, () =>
    Effect.gen(function* () {
      expect(
        (yield* requireSourceSyncProcessingPermit(alteredScope, request, response(), now).pipe(Effect.flip)).code,
      ).toBe('DENIED');
    }),
  );
}
for (const [field, value] of [
  ['authorityIncarnation', 'different-policy'],
  ['authorityRevision', 'v1'],
] as const) {
  it.effect(`rejects uncorrelated ${field}`, () =>
    Effect.gen(function* () {
      expect(
        (yield* requireSourceSyncProcessingPermit(scope, request, response({}, { [field]: value }), now).pipe(
          Effect.flip,
        )).code,
      ).toBe('DENIED');
    }),
  );
}

it.effect('does not contact source-sync authority when the owner has not selected source-sync mode', () =>
  Effect.gen(function* () {
    let calls = 0;
    const denied = yield* acquireSourceSyncProcessingPermit(
      scope,
      {
        check: () => {
          calls++;
          return Effect.die('Unselected mode must never acquire authority');
        },
      },
      request,
      'unit-requirement',
    ).pipe(Effect.flip);
    expect(denied.code).toBe('DENIED');
    expect(calls).toBe(0);
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
);
it.effect('does not confuse ordinary processing evidence with a source-sync permit', () =>
  Effect.gen(function* () {
    const ordinary = response(
      {},
      {
        evidence: {
          authoritativeReferences: [],
          currentnessConditions: [],
          policyRevisions: [],
          reasonCodes: ['native-current-processing'],
          trustedDecisionTime: now,
          outcome: 'ALLOWED',
          evaluatedScope: {
            controllerRef: 'controller',
            dataCategoryRefs: ['category'],
            operation: request.operation,
            processingScopeRef: { scopeId: 'scope', scopeType: 'privacy.processing-scope' },
            purposeRef: 'purpose',
            purposeVersionId: '1',
            recipientRefs: [],
            subjectRef: {
              moduleId: 'privacy.core',
              resourceId: '10000000-0000-4000-8000-000000000006',
              resourceType: 'privacy.core.privacy-subject',
              tenantId: scope.tenantId,
            },
          },
        },
      },
    );
    expect((yield* requireSourceSyncProcessingPermit(scope, request, ordinary, now).pipe(Effect.flip)).code).toBe(
      'DENIED',
    );
  }),
);
