import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
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
import { RetireMarketPayloadSchema, retireMarketAction } from '../../src/actions/retire-market.action.ts';
import type { RetireMarketServices } from '../../src/actions/retire-market.action.ts';
import {
  MarketRetirementIntentSnapshotSchema,
  MarketRetirementRequestOutcomeSchema,
} from '../../src/persistence/market-retirement-intent-persistence.ts';
import { reviseMarketDefinitionAction } from '../../src/actions/revise-market-definition.action.ts';
import { reviseStorefrontAssociationAction } from '../../src/actions/revise-storefront-association.action.ts';
import { suspendMarketAction } from '../../src/actions/suspend-market.action.ts';
import type { MarketAdministrationService } from '../../src/services/market-administration.service.ts';

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

const retirementPayload = (expectedRevision = 3) =>
  Schema.decodeUnknownSync(RetireMarketPayloadSchema)({
    effectiveAt: retirementEffectiveAt,
    expectedCurrentDefinitionRevisionRef: definitionRevisionRef,
    expectedRevision,
    marketRef,
    reason: 'Retire replaced Market.',
  });

const intentId = '88888888-8888-4888-8888-888888888888';
const requestedIntent = Schema.decodeUnknownSync(MarketRetirementIntentSnapshotSchema)({
  actingPrincipalId: principalId,
  actionInvocationId,
  effectiveAt: retirementEffectiveAt,
  expectedDefinitionRevisionId: definitionRevisionId,
  expectedRevision: 3,
  intentId,
  legalEntityId: sellerId,
  marketId,
  reason: 'Retire replaced Market.',
  stage: 'REQUESTED',
  tenantId,
});

const requestOutcome = Schema.decodeUnknownSync(MarketRetirementRequestOutcomeSchema);

const unexpected = () => Effect.die('unexpected Market administration service call');
const unavailableServices: MarketAdministrationService = {
  associateStorefront: unexpected,
  createMarket: unexpected,
  removeStorefrontAssociation: unexpected,
  reviseMarketDefinition: unexpected,
  reviseStorefrontAssociation: unexpected,
  transitionLifecycle: unexpected,
};

const retirementCollector = () =>
  createActionCollector(
    retireMarketAction.descriptor.domainEvents,
    'commerce.market-catalog',
    retireMarketAction.descriptor.accessEvidencePolicy,
    retireMarketAction.descriptor.auditEvidenceSchema,
  );

const retirementContext = (collector: ReturnType<typeof retirementCollector>) => ({
  actionInvocationId,
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  compositionRevision,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope,
});

const retirementServices = (request: RetireMarketServices['request']): RetireMarketServices => ({
  advance: unexpected,
  read: unexpected,
  request,
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

  it.effect('records a pending durable retirement intent with its self-outbox request and no remote call', () =>
    Effect.gen(function* pendingRetirement() {
      const collector = retirementCollector();
      const requests: unknown[] = [];
      const result = yield* getActionHandler(retireMarketAction)(retirementPayload(), {
        ...retirementContext(collector),
        services: retirementServices((command) => {
          requests.push(command);
          return Effect.succeed({ _tag: 'requested', intent: requestedIntent } as const);
        }),
      });
      expect(result).toEqual({
        marketRef,
        outcome: 'pending',
        retirementIntentId: intentId,
        stage: 'REQUESTED',
      });
      expect(requests).toEqual([
        {
          actionInvocationId,
          effectiveAt: retirementPayload().effectiveAt,
          expectedCurrentDefinitionRevisionId: definitionRevisionId,
          expectedRevision: 3,
          marketId,
          principalId,
          reason: 'Retire replaced Market.',
          recordedAt: expect.anything(),
        },
      ]);
      const evidence = collector.snapshot();
      expect(evidence.domainEvents.map(({ eventType }) => eventType)).toEqual([
        'commerce.market-catalog.market-retirement-requested.v1',
      ]);
      expect(evidence.outboxMessages).toHaveLength(1);
      expect(evidence.outboxMessages[0]?.message).toMatchObject({
        payloadJson: { legalEntityId: sellerId, marketRef, retirementIntentId: intentId },
        topic: 'commerce.market-catalog.market-retirement-requested.v1',
      });
      expect(evidence.auditEvidence).toMatchObject({
        operation: 'REQUEST_RETIREMENT',
        outcome: 'pending',
        retirementIntentId: intentId,
      });
    }),
  );

  it.effect('completes without a new intent when the Market is already retired at the observed revision', () =>
    Effect.gen(function* alreadyRetired() {
      const collector = retirementCollector();
      const result = yield* getActionHandler(retireMarketAction)(retirementPayload(), {
        ...retirementContext(collector),
        services: retirementServices(() =>
          Effect.succeed(requestOutcome({ _tag: 'already_retired', definitionRevisionId, revision: 3 })),
        ),
      });
      expect(result).toEqual({
        changed: false,
        definitionRevisionRef,
        lifecycle: 'RETIRED',
        marketRef,
        outcome: 'completed',
        revision: 3,
      });
      expect(collector.snapshot().domainEvents).toHaveLength(0);
      expect(collector.snapshot().outboxMessages).toHaveLength(0);
    }),
  );

  it.effect('rejects a concurrent retirement, a stale revision, and an invalid transition before any event', () =>
    Effect.gen(function* rejectedRetirement() {
      const cases = [
        [requestOutcome({ _tag: 'retirement_in_progress', intentId }), 'retirement_in_progress'],
        [requestOutcome({ _tag: 'revision_conflict', actualRevision: 4 }), 'revision_conflict'],
        [requestOutcome({ _tag: 'invalid_lifecycle_transition' }), 'invalid_lifecycle_transition'],
        [requestOutcome({ _tag: 'not_found' }), 'cross_tenant_reference'],
      ] as const;
      for (const [outcome, code] of cases) {
        const collector = retirementCollector();
        const failure = yield* getActionHandler(retireMarketAction)(retirementPayload(), {
          ...retirementContext(collector),
          services: retirementServices(() => Effect.succeed(outcome)),
        }).pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'MarketCommandRejected')).toBe(true);
        expect(failure).toMatchObject({ code });
        expect(collector.snapshot().domainEvents).toHaveLength(0);
      }
    }),
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
