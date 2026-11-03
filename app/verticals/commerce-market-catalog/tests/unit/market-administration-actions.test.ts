import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionHandler,
  getActionResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { activateMarketAction } from '../../src/actions/activate-market.action.ts';
import { associateStorefrontAction } from '../../src/actions/associate-storefront.action.ts';
import { CreateMarketPayloadSchema, createMarketAction } from '../../src/actions/create-market.action.ts';
import { removeStorefrontAssociationAction } from '../../src/actions/remove-storefront-association.action.ts';
import {
  MarketRetirementImpactAssessmentUnavailable,
  RetireMarketPayloadSchema,
  retireMarketAction,
} from '../../src/actions/retire-market.action.ts';
import type { RetireMarketServices } from '../../src/actions/retire-market.action.ts';
import type { MarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';
import { reviseMarketDefinitionAction } from '../../src/actions/revise-market-definition.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
const compositionRevision = 'a'.repeat(64);
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const definitionRevisionRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: definitionRevisionId,
  resourceType: 'commerce.market-catalog.market-definition-revision',
  tenantId,
} as const;
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const scope = {
  authMethod: 'system' as const,
  correlationId: 'market-administration-actions',
  legalEntityId: sellerId,
  principalId,
  tenantId,
};
const createPayloadInput = {
  channels: ['B2C'],
  effectivePeriod: { startsAt: '2026-10-01T00:00:00.000Z' },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_MAIN',
  marketId,
  purpose: 'Czech direct commerce.',
  reason: 'Initial approved Market definition.',
  sellingLegalEntityRef: sellerRef,
  supportedLocales: ['cs-CZ'],
} as const;
const createPayload = Schema.decodeUnknownSync(CreateMarketPayloadSchema)(createPayloadInput);
const retirementEffectiveAt = '2026-12-01T00:00:00.000Z';
const retirementReservationToken = '77777777-7777-4777-8777-777777777777';

const retirementPayload = (expectedRevision = 3) =>
  Schema.decodeUnknownSync(RetireMarketPayloadSchema)({
    effectiveAt: retirementEffectiveAt,
    expectedCurrentDefinitionRevisionRef: definitionRevisionRef,
    expectedRevision,
    marketRef,
    reason: 'Retire replaced Market.',
  });

const retirementImpactAssessment = (
  overrides: Partial<MarketRetirementImpactAssessment> = {},
): MarketRetirementImpactAssessment => ({
  assessedMarketRef: retirementPayload().marketRef,
  assessedMarketRevision: 3,
  assessmentDigest: 'a'.repeat(64),
  effectiveAt: retirementEffectiveAt,
  providers: [
    {
      completenessEvidenceReference: 'customer-context:market-impact-completeness:17',
      currentnessEvidenceReference: 'customer-context:market-impact-currentness:17',
      effectiveAt: retirementEffectiveAt,
      liveBlockingReferences: {
        count: 0,
        evidenceReference: 'customer-context:live-market-references:17',
      },
      nextBoundaryAt: '2027-01-01T00:00:00.000Z',
      observedAt: '2026-11-30T23:59:59.000Z',
      ownerModuleKey: 'commerce.customer-context',
      ownerRevision: 'customer-context-policy:17',
      retainedHistoryEvidence: {
        count: 1,
        evidenceReference: 'customer-context:retained-market-history:17',
      },
      versionToken: 'customer-context-market-impact:17',
    },
  ],
  requiredProviderModuleKeys: ['commerce.customer-context'],
  ...overrides,
});

const reservedRetirementImpactAssessment = () => ({
  ...retirementImpactAssessment(),
  reservation: { token: retirementReservationToken, version: 7 },
});

const unexpected = () => Effect.die('unexpected Market administration service call');
const unavailableServices: RetireMarketServices = {
  associateStorefront: unexpected,
  commit: unexpected,
  createMarket: unexpected,
  lockPending: unexpected,
  preparedRetirement: Effect.fail(
    new MarketRetirementImpactAssessmentUnavailable({
      code: 'market_retirement_impact_assessment_unavailable',
      reason: 'No prepared admission',
    }),
  ),
  removeStorefrontAssociation: unexpected,
  reviseMarketDefinition: unexpected,
  reviseStorefrontAssociation: unexpected,
  transitionLifecycle: unexpected,
};

const collectCreate = (changed: boolean) =>
  Effect.gen(function* collectCreateEvidence() {
    const collector = createActionCollector(
      createMarketAction.descriptor.domainEvents,
      'commerce.market-catalog',
      createMarketAction.descriptor.accessEvidencePolicy,
      createMarketAction.descriptor.auditEvidenceSchema,
    );
    const result = yield* getActionHandler(createMarketAction)(createPayload, {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      compositionRevision,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: {
        ...unavailableServices,
        createMarket: () =>
          Effect.succeed(
            changed
              ? ({
                  _tag: 'created',
                  changed: true,
                  definitionRevisionId,
                  generation: 1,
                  revision: 1,
                } as const)
              : ({
                  _tag: 'reused',
                  changed: false,
                  definitionRevisionId,
                  generation: 1,
                  revision: 1,
                } as const),
          ),
      },
    });
    return { evidence: collector.snapshot(), result };
  });

describe('Market administration Actions', () => {
  it('keeps every mutation on the generated governed action/write boundary', () => {
    const actions = [
      activateMarketAction,
      associateStorefrontAction,
      createMarketAction,
      removeStorefrontAssociationAction,
      retireMarketAction,
      reviseMarketDefinitionAction,
      reviseStorefrontAssociationAction,
      suspendMarketAction,
    ];
    for (const action of actions) {
      expect(action.descriptor.entrypoint).toMatchObject({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'explicit' },
        moduleKey: 'commerce.market-catalog',
        role: 'action',
        scope: 'tenant',
      });
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('required');
    }
  });

  it('targets exact catalog authority and fails closed on a mismatched trusted seller scope', () => {
    const resolve = getActionResourcePermissionTargetResolver(createMarketAction);
    expect(resolve?.(createPayload, scope)).toEqual({
      permission: 'write',
      resource: {
        moduleId: 'commerce.market-catalog',
        resourceId: sellerId,
        resourceType: 'commerce.market-catalog.market-catalog-root',
      },
    });
    expect(() => resolve?.(createPayload, { ...scope, legalEntityId: marketId })).toThrow();
  });

  it.effect('emits audit, data-access, domain, and outbox evidence once and emits no event on replay', () =>
    Effect.gen(function* createEvidence() {
      const created = yield* collectCreate(true);
      expect(created.result).toMatchObject({ created: true });
      expect(created.evidence.auditEvidence).toMatchObject({
        changed: true,
        completenessGeneration: 1,
        operation: 'CREATE',
      });
      expect(created.evidence.dataAccessEvents).toHaveLength(1);
      expect(created.evidence.domainEvents).toHaveLength(1);
      expect(created.evidence.outboxMessages).toHaveLength(1);

      const replay = yield* collectCreate(false);
      expect(replay.result).toMatchObject({ created: false });
      expect(replay.evidence.auditEvidence).toMatchObject({ changed: false, completenessGeneration: 1 });
      expect(replay.evidence.domainEvents).toHaveLength(0);
      expect(replay.evidence.outboxMessages).toHaveLength(0);
    }),
  );

  it.effect('runs only local transition and receipt writes after locking the exact prepared admission', () =>
    Effect.gen(function* localRetirement() {
      const calls: string[] = [];
      const assessment = reservedRetirementImpactAssessment();
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* getActionHandler(retireMarketAction)(retirementPayload(), {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        compositionRevision,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          commit: (input) => {
            calls.push('receipt');
            expect(input.assessment.reservation).toEqual(assessment.reservation);
            expect(input.result.lifecycle).toBe('RETIRED');
            return Effect.void;
          },
          lockPending: (input) => {
            calls.push('lock');
            expect(input.sourceActionInvocationId).toBe(actionInvocationId);
            return Effect.void;
          },
          preparedRetirement: Effect.succeed({ actionInvocationId, assessment }),
          transitionLifecycle: (input) => {
            calls.push('transition');
            expect(input.retirementImpactAssessment).toEqual(assessment);
            return Effect.succeed({
              _tag: 'transitioned',
              changed: true,
              definitionRevisionId,
              generation: 2,
              lifecycle: 'RETIRED',
              revision: 4,
            } as const);
          },
        },
      });
      expect(calls).toEqual(['lock', 'transition', 'receipt']);
      expect(result).toMatchObject({ lifecycle: 'RETIRED', revision: 4 });
      expect(collector.snapshot().domainEvents).toHaveLength(1);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  for (const scenario of [
    'missing',
    'other-invocation',
    'stale',
    'provider-missing',
    'live-reference',
    'admission-closed',
  ] as const) {
    const expectedRejection = {
      'admission-closed': 'MarketRetirementImpactAssessmentUnavailable',
      'live-reference': 'MarketCommandRejected',
      missing: 'MarketRetirementImpactAssessmentUnavailable',
      'other-invocation': 'MarketRetirementImpactAssessmentUnavailable',
      'provider-missing': 'MarketRetirementImpactAssessmentUnavailable',
      stale: 'MarketRetirementImpactAssessmentStale',
    } as const;
    it.effect(`rejects ${scenario} before any local lifecycle write`, () =>
      Effect.gen(function* rejectUnpreparedRetirement() {
        const collector = createActionCollector(
          retireMarketAction.descriptor.domainEvents,
          'commerce.market-catalog',
          retireMarketAction.descriptor.accessEvidencePolicy,
          retireMarketAction.descriptor.auditEvidenceSchema,
        );
        let writes = 0;
        let overrides: Partial<MarketRetirementImpactAssessment> = {};
        if (scenario === 'stale') {
          overrides = { assessedMarketRevision: 2 };
        } else if (scenario === 'provider-missing') {
          overrides = { providers: [] };
        } else if (scenario === 'live-reference') {
          overrides = {
            providers: retirementImpactAssessment().providers.map((provider) => ({
              ...provider,
              liveBlockingReferences: { count: 1, evidenceReference: 'live-reference' },
            })),
          };
        }
        const assessment = {
          ...reservedRetirementImpactAssessment(),
          ...retirementImpactAssessment(overrides),
        };
        const failure = yield* getActionHandler(retireMarketAction)(retirementPayload(), {
          actionInvocationId,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          compositionRevision,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope,
          services: {
            ...unavailableServices,
            lockPending: () =>
              scenario === 'admission-closed'
                ? Effect.fail(
                    new MarketRetirementImpactAssessmentUnavailable({
                      code: 'market_retirement_impact_assessment_unavailable',
                      reason: 'Admission is already closed',
                    }),
                  )
                : Effect.void,
            preparedRetirement:
              scenario === 'missing'
                ? unavailableServices.preparedRetirement
                : Effect.succeed({
                    actionInvocationId: scenario === 'other-invocation' ? definitionRevisionId : actionInvocationId,
                    assessment,
                  }),
            transitionLifecycle: () => {
              writes += 1;
              return unexpected();
            },
          },
        }).pipe(Effect.flip);
        expect(Predicate.isTagged(failure, expectedRejection[scenario])).toBe(true);
        expect(writes).toBe(0);
        expect(collector.snapshot().domainEvents).toHaveLength(0);
      }).pipe(Effect.provide(NodeCrypto.layer)),
    );
  }

  it.effect(
    'denies missing or unavailable executor/resource authority before transaction or owner service resolution',
    () =>
      Effect.gen(function* permissionGate() {
        const principal = {
          authBindingId: '77777777-7777-4777-8777-777777777777',
          authContextRef: 'better-auth-session:market-administration',
          authMethod: 'session' as const,
          legalEntityId: sellerId,
          principalId,
          tenantId,
        };
        const request = {
          payload: createPayloadInput,
          principal,
          registration: createMarketAction,
          transport: { correlationId: 'market-permission-gate', idempotencyKey: 'create-market-cz-main' },
        } as const;
        for (const resourcePermission of ['denied', 'unavailable'] as const) {
          const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', resourcePermission });
          const failure = yield* harness.runtime.runAction(request).pipe(Effect.flip);
          expect(
            resourcePermission === 'denied'
              ? Predicate.isTagged(failure, 'ActionPermissionDenied')
              : Predicate.isTagged(failure, 'ActionPermissionCheckError'),
          ).toBe(true);
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().stages).not.toContain('handler_executed');
        }
      }),
  );
});
