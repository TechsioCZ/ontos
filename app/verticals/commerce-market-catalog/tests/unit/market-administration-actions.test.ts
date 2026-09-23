import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Layer, Predicate, Schema } from 'effect';
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
  MarketRetirementImpactAssessmentRejected,
  MarketRetirementImpactAssessmentUnavailable,
  RetireMarketPayloadSchema,
  retireMarketAction,
} from '../../src/actions/retire-market.action.ts';
import type { RetireMarketServices } from '../../src/actions/retire-market.action.ts';
import type { MarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';
import { reviseMarketDefinitionAction } from '../../src/actions/revise-market-definition.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import { MarketRetirementImpactAuthorityService } from '../../src/services/market-retirement-impact-authority.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';
import type { MarketAdministrationService } from '../../src/services/market-administration.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
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
  assessRetirementImpact: unexpected,
  associateStorefront: unexpected,
  commitRetirementImpact: unexpected,
  createMarket: unexpected,
  releaseRetirementImpact: unexpected,
  removeStorefrontAssociation: unexpected,
  reserveRetirementImpact: unexpected,
  reviseMarketDefinition: unexpected,
  reviseStorefrontAssociation: unexpected,
  transitionLifecycle: unexpected,
};
const retirementImpactAuthorityTestLayer = Layer.succeed(MarketRetirementImpactAuthorityService, {
  assessRetirementImpact: unexpected,
  commitRetirementImpact: unexpected,
  releaseRetirementImpact: unexpected,
  reserveRetirementImpact: unexpected,
});

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

  it.effect('blocks retirement with unresolved affected use before persistence', () =>
    Effect.gen(function* affectedUse() {
      const payload = retirementPayload();
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () =>
            Effect.succeed({
              ...retirementImpactAssessment(),
              providers: retirementImpactAssessment().providers.map((provider) => ({
                ...provider,
                liveBlockingReferences: {
                  count: 1,
                  evidenceReference: 'customer-context:live-market-references:18',
                },
              })),
            }),
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketCommandRejected')).toBe(true);
      expect(failure).toMatchObject({ code: 'replacement_impact_unresolved' });
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('fails closed when the owner rejects the atomic retirement reservation', () =>
    Effect.gen(function* rejectedReservation() {
      const payload = retirementPayload();
      const persistenceCalls: string[] = [];
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () => Effect.succeed(retirementImpactAssessment()),
          reserveRetirementImpact: () =>
            Effect.fail(
              new MarketRetirementImpactAssessmentRejected({
                code: 'market_retirement_impact_assessment_rejected',
                reason: 'Owner evidence changed before the reservation barrier was acquired',
              }),
            ),
          transitionLifecycle: () => {
            persistenceCalls.push('transitionLifecycle');
            return unexpected();
          },
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentRejected')).toBe(true);
      expect(failure).toMatchObject({ code: 'market_retirement_impact_assessment_rejected' });
      expect(persistenceCalls).toHaveLength(0);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('fails closed when authoritative retirement-impact assessment is unavailable', () =>
    Effect.gen(function* unavailableAssessment() {
      const payload = retirementPayload();
      const persistenceCalls: string[] = [];
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () =>
            Effect.fail(
              new MarketRetirementImpactAssessmentUnavailable({
                code: 'market_retirement_impact_assessment_unavailable',
                reason: 'Customer Context authority unavailable',
              }),
            ),
          transitionLifecycle: () => {
            persistenceCalls.push('transitionLifecycle');
            return unexpected();
          },
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(failure).toMatchObject({ code: 'market_retirement_impact_assessment_unavailable' });
      expect(persistenceCalls).toHaveLength(0);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('fails closed when owner evidence was assessed against a stale Market revision', () =>
    Effect.gen(function* staleAssessment() {
      const payload = retirementPayload();
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () => Effect.succeed(retirementImpactAssessment({ assessedMarketRevision: 2 })),
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentStale')).toBe(true);
      expect(failure).toMatchObject({ code: 'market_retirement_impact_assessment_stale' });
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('fails closed when a required provider is missing from the complete assessment', () =>
    Effect.gen(function* missingProvider() {
      const payload = retirementPayload();
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () =>
            Effect.succeed(retirementImpactAssessment({ providers: [], requiredProviderModuleKeys: ['cart'] })),
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(failure).toMatchObject({ code: 'market_retirement_impact_assessment_unavailable' });
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('keeps authority rejection distinct from unavailable and stale evidence', () =>
    Effect.gen(function* rejectedAssessment() {
      const payload = retirementPayload();
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () =>
            Effect.fail(
              new MarketRetirementImpactAssessmentRejected({
                code: 'market_retirement_impact_assessment_rejected',
                reason: 'Owner rejected the retirement reservation',
              }),
            ),
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentRejected')).toBe(true);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentStale')).toBe(false);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('allows retained history and preserves exact authoritative provider evidence', () =>
    Effect.gen(function* successfulRetirement() {
      const payload = retirementPayload();
      const impactAssessment = retirementImpactAssessment();
      const reservedImpactAssessment = reservedRetirementImpactAssessment();
      const reservationCalls: string[] = [];
      const transitionInputs: Parameters<MarketAdministrationService['transitionLifecycle']>[0][] = [];
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const result = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () => Effect.succeed(impactAssessment),
          commitRetirementImpact: ({ assessment }) => {
            reservationCalls.push(`commit:${assessment.reservation.token}:${assessment.reservation.version}`);
            return Effect.void;
          },
          reserveRetirementImpact: () => Effect.succeed(reservedImpactAssessment),
          transitionLifecycle: (input) => {
            transitionInputs.push(input);
            return Effect.succeed({
              _tag: 'transitioned',
              changed: true,
              definitionRevisionId,
              generation: 0,
              lifecycle: 'RETIRED',
              revision: 4,
            } as const);
          },
        },
      });
      expect(result).toMatchObject({ changed: true, lifecycle: 'RETIRED', revision: 4 });
      expect(transitionInputs).toHaveLength(1);
      expect(transitionInputs[0]).toMatchObject({ retirementImpactAssessment: reservedImpactAssessment });
      expect(collector.snapshot().auditEvidence).toMatchObject({
        retirementImpactAssessment: reservedImpactAssessment,
      });
      expect(reservationCalls).toEqual([`commit:${retirementReservationToken}:7`]);
      expect(collector.snapshot().dataAccessEvents).toContainEqual(
        expect.objectContaining({
          queryHash: `market-retirement-impact:${marketId}:commerce.customer-context:customer-context-policy:17:customer-context-market-impact:17`,
          resultCount: 1,
          servingModuleKey: 'commerce.customer-context',
        }),
      );
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('leaves the reservation fail-closed when COMMIT has an indeterminate failure', () =>
    Effect.gen(function* uncertainCommit() {
      const payload = retirementPayload();
      const reservationCalls: string[] = [];
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () => Effect.succeed(retirementImpactAssessment()),
          commitRetirementImpact: () => {
            reservationCalls.push('commit');
            return Effect.fail(
              new MarketRetirementImpactAssessmentUnavailable({
                code: 'market_retirement_impact_assessment_unavailable',
                reason: 'The COMMIT response is indeterminate',
              }),
            );
          },
          releaseRetirementImpact: () => {
            reservationCalls.push('release');
            return Effect.void;
          },
          reserveRetirementImpact: () => Effect.succeed(reservedRetirementImpactAssessment()),
          transitionLifecycle: () =>
            Effect.succeed({
              _tag: 'transitioned',
              changed: true,
              definitionRevisionId,
              generation: 0,
              lifecycle: 'RETIRED',
              revision: 4,
            } as const),
        },
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(reservationCalls).toEqual(['commit']);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

  it.effect('revalidates affected use and does not persist when a concurrent provider change adds a blocker', () =>
    Effect.gen(function* concurrentAffectedUse() {
      const payload = retirementPayload();
      let assessmentCalls = 0;
      const persistenceCalls: string[] = [];
      const reservationCalls: string[] = [];
      const collector = createActionCollector(
        retireMarketAction.descriptor.domainEvents,
        'commerce.market-catalog',
        retireMarketAction.descriptor.accessEvidencePolicy,
        retireMarketAction.descriptor.auditEvidenceSchema,
      );
      const failure = yield* getActionHandler(retireMarketAction)(payload, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          assessRetirementImpact: () => {
            assessmentCalls += 1;
            return Effect.succeed(retirementImpactAssessment());
          },
          releaseRetirementImpact: ({ assessment }) => {
            reservationCalls.push(`release:${assessment.reservation.token}:${assessment.reservation.version}`);
            return Effect.void;
          },
          reserveRetirementImpact: () => {
            reservationCalls.push('reserve');
            const assessment = reservedRetirementImpactAssessment();
            return Effect.succeed({
              ...assessment,
              assessmentDigest: 'b'.repeat(64),
              providers: assessment.providers.map((provider) => ({
                ...provider,
                liveBlockingReferences: {
                  count: 1,
                  evidenceReference: 'customer-context:live-market-references:concurrent',
                },
                ownerRevision: 'customer-context-policy:18',
                versionToken: 'customer-context-market-impact:18',
              })),
            });
          },
          transitionLifecycle: () => {
            persistenceCalls.push('transitionLifecycle');
            return unexpected();
          },
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketCommandRejected')).toBe(true);
      expect(failure).toMatchObject({ code: 'replacement_impact_unresolved' });
      expect(assessmentCalls).toBe(1);
      expect(reservationCalls).toEqual(['reserve', `release:${retirementReservationToken}:7`]);
      expect(persistenceCalls).toHaveLength(0);
      expect(collector.snapshot().auditEvidence).toEqual({});
      expect(collector.snapshot().domainEvents).toHaveLength(0);
    }).pipe(Effect.provide(retirementImpactAuthorityTestLayer)),
  );

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
