/* eslint-disable effect-native/no-manual-tag-comparison -- Contract assertions prove exact generated discriminant serialization; expires: 2027-03-01. */
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  AssignCounterpartyPriceGroupPayloadSchema,
  assignCounterpartyPriceGroupAction,
} from '../../src/actions/assign-counterparty-price-group.action.ts';
import {
  AssignCustomerPriceGroupPayloadSchema,
  assignCustomerPriceGroupAction,
  handleAssignCustomerPriceGroup,
} from '../../src/actions/assign-customer-price-group.action.ts';
import {
  MigrateCustomerPriceGroupResultSchema,
  handleMigrateCustomerPriceGroup,
  migrateCustomerPriceGroupAction,
} from '../../src/actions/migrate-customer-price-group.action.ts';
import {
  handleMigrateCounterpartyPriceGroup,
  migrateCounterpartyPriceGroupAction,
} from '../../src/actions/migrate-counterparty-price-group.action.ts';
import {
  RemoveCustomerPriceGroupPayloadSchema,
  handleRemoveCustomerPriceGroup,
  removeCustomerPriceGroupAction,
} from '../../src/actions/remove-customer-price-group.action.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import { createAssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxMessage } from '../../src/actions/assign-customer-price-group.commerce-customer-context-customer-price-group-assigned-v1.outbox-message.ts';
import { createAssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxMessage } from '../../src/actions/assign-counterparty-price-group.commerce-customer-context-counterparty-price-group-assigned-v1.outbox-message.ts';
import { createMigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxMessage } from '../../src/actions/migrate-customer-price-group.commerce-customer-context-customer-price-group-migrated-v1.outbox-message.ts';
import { createMigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxMessage } from '../../src/actions/migrate-counterparty-price-group.commerce-customer-context-counterparty-price-group-migrated-v1.outbox-message.ts';
import { createRemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxMessage } from '../../src/actions/remove-customer-price-group.commerce-customer-context-customer-price-group-removed-v1.outbox-message.ts';
import { createRemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxMessage } from '../../src/actions/remove-counterparty-price-group.commerce-customer-context-counterparty-price-group-removed-v1.outbox-message.ts';
import { OutboxPayloadSchema as CounterpartyAssignedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-counterparty-price-group-assigned-v1.ts';
import { OutboxPayloadSchema as CounterpartyMigratedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-counterparty-price-group-migrated-v1.ts';
import { OutboxPayloadSchema as CounterpartyRemovedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-counterparty-price-group-removed-v1.ts';
import { OutboxPayloadSchema as AssignedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-customer-price-group-assigned-v1.ts';
import { OutboxPayloadSchema as MigratedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-customer-price-group-migrated-v1.ts';
import { OutboxPayloadSchema as RemovedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-customer-price-group-removed-v1.ts';
import { CustomerPriceGroupRetroactiveScheduleRejected } from '../../shared/domain/price-group-errors.ts';
import type {
  CustomerPriceGroupAssignmentStorePort,
  CustomerPriceGroupProfileValidationPort,
  PriceGroupCatalogPort,
} from '../../shared/domain/price-group-ports.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const priceGroupRef = {
  moduleId: 'pricing.catalog',
  resourceId: 'contract-pricing',
  resourceType: 'pricing.catalog.price-group',
  tenantId,
} as const;
const assignmentRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'assignment-1',
  resourceType: 'commerce.customer-context.customer-price-group-assignment',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const counterpartyProfile = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;

const unreachable = () => Effect.die('retroactive schedules must fail before dependencies run');
const unreachableStore: CustomerPriceGroupAssignmentStorePort = {
  assign: unreachable,
  list: unreachable,
  migrate: unreachable,
  remove: unreachable,
  resolve: unreachable,
};
const unreachableProfileValidation: CustomerPriceGroupProfileValidationPort = {
  inspect: unreachable,
};
const unreachableCatalog: PriceGroupCatalogPort = { resolveCurrent: unreachable };
const temporalScope = {
  authMethod: 'system' as const,
  correlationId: 'price-group-temporal-contract',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
};

const collectorFor = (action: typeof assignCustomerPriceGroupAction) =>
  createActionCollector(
    action.descriptor.domainEvents,
    'commerce.customer-context',
    action.descriptor.accessEvidencePolicy,
    action.descriptor.auditEvidenceSchema,
  );

describe('customer PriceGroup Actions', () => {
  it('keeps every state change explicit, audited, legally scoped, and idempotent', () => {
    for (const action of [
      assignCustomerPriceGroupAction,
      removeCustomerPriceGroupAction,
      migrateCustomerPriceGroupAction,
    ]) {
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.auditProfile).toBe('standard');
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('required');
    }
  });

  it('accepts immediate/future assignment and exact revision-guarded removal contracts', () => {
    const assigned = Schema.decodeUnknownSync(AssignCustomerPriceGroupPayloadSchema)({
      effectiveFrom: '2027-01-01T00:00:00.000Z',
      expectedProfileRevision: 2,
      priceGroupRef,
      profile,
      reason: 'Negotiated 2027 terms',
    });
    expect(assigned.effectiveTo).toBeUndefined();

    const removed = Schema.decodeUnknownSync(RemoveCustomerPriceGroupPayloadSchema)({
      assignmentRef,
      effectiveAt: '2027-06-01T00:00:00.000Z',
      expectedRevision: 3,
      profile,
      reason: 'Contract ended',
    });
    expect(removed.assignmentRef).toEqual(assignmentRef);
    expect(removed.expectedRevision).toBe(3);
  });

  it('publishes a conflict inventory instead of partially reporting bulk migration success', () => {
    const result = Schema.decodeUnknownSync(MigrateCustomerPriceGroupResultSchema)({
      _tag: 'CONFLICTS',
      conflicts: [{ assignmentRef, reason: 'ASSIGNMENT_CHANGED' }],
    });
    expect(result).toEqual({
      _tag: 'CONFLICTS',
      conflicts: [{ assignmentRef, reason: 'ASSIGNMENT_CHANGED' }],
    });
  });

  it('publishes exact typed invalidation payloads on the three generated outbox topics', () => {
    const assignmentPayload = {
      assignmentRef,
      assignmentRevision: 4,
      change: 'ASSIGNED' as const,
      effectiveAt: '2027-01-01T00:00:00.000Z',
      priceGroupRef,
      profile,
    };
    expect(Schema.is(AssignedOutboxPayloadSchema)(assignmentPayload)).toBe(true);
    expect(
      Schema.is(AssignedOutboxPayloadSchema)({ ...assignmentPayload, change: 'REMOVED' }),
    ).toBe(false);
    expect(
      createAssignCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupAssignedV1OutboxMessage(
        assignmentPayload,
      ),
    ).toMatchObject({
      payloadJson: assignmentPayload,
      producerModuleKey: 'commerce.customer-context',
      topic: 'commerce.customer-context.customer-price-group-assigned.v1',
    });

    const removalPayload = { ...assignmentPayload, change: 'REMOVED' as const };
    expect(Schema.is(RemovedOutboxPayloadSchema)(removalPayload)).toBe(true);
    expect(
      createRemoveCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupRemovedV1OutboxMessage(
        removalPayload,
      ).topic,
    ).toBe('commerce.customer-context.customer-price-group-removed.v1');

    const migrationPayload = {
      assignmentRefs: [assignmentRef],
      effectiveAt: '2027-01-01T00:00:00.000Z',
      profiles: [profile],
      sourceAssignmentRefs: [assignmentRef],
      sourcePriceGroupRef: priceGroupRef,
      targetPriceGroupRef: { ...priceGroupRef, resourceId: 'contract-pricing-v2' },
    };
    expect(Schema.is(MigratedOutboxPayloadSchema)(migrationPayload)).toBe(true);
    expect(
      createMigrateCustomerPriceGroupCommerceCustomerContextCustomerPriceGroupMigratedV1OutboxMessage(
        migrationPayload,
      ).topic,
    ).toBe('commerce.customer-context.customer-price-group-migrated.v1');
  });

  it('requires exact Counterparty permission declarations and explicit Counterparty identity', () => {
    for (const action of [
      assignCounterpartyPriceGroupAction,
      removeCounterpartyPriceGroupAction,
      migrateCounterpartyPriceGroupAction,
    ]) {
      expect(action.descriptor.businessPermission?.kind).toBe('business_permission');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.auditProfile).toBe('sensitive');
    }

    expect(
      Schema.decodeUnknownSync(AssignCounterpartyPriceGroupPayloadSchema)({
        counterpartyRef,
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        expectedProfileRevision: 2,
        priceGroupRef,
        profile: counterpartyProfile,
        reason: 'Negotiated Counterparty terms',
      }).counterpartyRef,
    ).toEqual(counterpartyRef);
    expect(
      Schema.is(AssignCounterpartyPriceGroupPayloadSchema)({
        effectiveFrom: '2027-01-01T00:00:00.000Z',
        expectedProfileRevision: 2,
        priceGroupRef,
        profile: counterpartyProfile,
        reason: 'Missing authority target',
      }),
    ).toBe(false);
  });

  it('publishes Counterparty identity on exact Counterparty price-group topics', () => {
    const assignedPayload = {
      assignmentRef,
      assignmentRevision: 5,
      change: 'ASSIGNED' as const,
      counterpartyRef,
      effectiveAt: '2027-01-01T00:00:00.000Z',
      priceGroupRef,
      profile: counterpartyProfile,
    };
    expect(Schema.is(CounterpartyAssignedOutboxPayloadSchema)(assignedPayload)).toBe(true);
    expect(
      Schema.is(CounterpartyAssignedOutboxPayloadSchema)({
        ...assignedPayload,
        counterpartyRef: null,
      }),
    ).toBe(false);
    expect(
      createAssignCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupAssignedV1OutboxMessage(
        assignedPayload,
      ).topic,
    ).toBe('commerce.customer-context.counterparty-price-group-assigned.v1');

    const removedPayload = { ...assignedPayload, change: 'REMOVED' as const };
    expect(Schema.is(CounterpartyRemovedOutboxPayloadSchema)(removedPayload)).toBe(true);
    expect(
      createRemoveCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupRemovedV1OutboxMessage(
        removedPayload,
      ).topic,
    ).toBe('commerce.customer-context.counterparty-price-group-removed.v1');

    const migratedPayload = {
      assignmentRefs: [assignmentRef],
      counterpartyRef,
      effectiveAt: '2027-01-01T00:00:00.000Z',
      profiles: [counterpartyProfile],
      sourceAssignmentRefs: [assignmentRef],
      sourcePriceGroupRef: priceGroupRef,
      targetPriceGroupRef: { ...priceGroupRef, resourceId: 'contract-pricing-v2' },
    };
    expect(Schema.is(CounterpartyMigratedOutboxPayloadSchema)(migratedPayload)).toBe(true);
    expect(
      createMigrateCounterpartyPriceGroupCommerceCustomerContextCounterpartyPriceGroupMigratedV1OutboxMessage(
        migratedPayload,
      ).topic,
    ).toBe('commerce.customer-context.counterparty-price-group-migrated.v1');
  });

  it.effect('rejects retroactive assign, remove, and migrate before downstream calls', () =>
    Effect.gen(function* rejectsRetroactiveSchedules() {
      const now = Effect.succeed('2027-01-02T00:00:00.000Z');
      const assignCollector = collectorFor(assignCustomerPriceGroupAction);
      const assignFailure = yield* handleAssignCustomerPriceGroup(
        {
          effectiveFrom: '2027-01-01T00:00:00.000Z',
          expectedProfileRevision: 2,
          priceGroupRef,
          profile,
          reason: 'Retroactive assignment',
        },
        {
          actionInvocationId: '44444444-4444-4444-8444-444444444441',
          addDomainEvent: assignCollector.addDomainEvent,
          addOutboxMessage: assignCollector.addOutboxMessage,
          recordAuditEvidence: assignCollector.recordAuditEvidence,
          recordDataAccess: assignCollector.recordDataAccess,
          scope: temporalScope,
          services: {
            catalog: unreachableCatalog,
            now,
            profileValidation: unreachableProfileValidation,
            store: unreachableStore,
          },
        },
      ).pipe(Effect.flip);
      expect(Schema.is(CustomerPriceGroupRetroactiveScheduleRejected)(assignFailure)).toBe(true);

      const removeCollector = createActionCollector(
        removeCustomerPriceGroupAction.descriptor.domainEvents,
        'commerce.customer-context',
        removeCustomerPriceGroupAction.descriptor.accessEvidencePolicy,
        removeCustomerPriceGroupAction.descriptor.auditEvidenceSchema,
      );
      const removeFailure = yield* handleRemoveCustomerPriceGroup(
        {
          assignmentRef,
          effectiveAt: '2027-01-01T00:00:00.000Z',
          expectedRevision: 3,
          profile,
          reason: 'Retroactive removal',
        },
        {
          actionInvocationId: '44444444-4444-4444-8444-444444444442',
          addDomainEvent: removeCollector.addDomainEvent,
          addOutboxMessage: removeCollector.addOutboxMessage,
          recordAuditEvidence: removeCollector.recordAuditEvidence,
          recordDataAccess: removeCollector.recordDataAccess,
          scope: temporalScope,
          services: { now, store: unreachableStore },
        },
      ).pipe(Effect.flip);
      expect(Schema.is(CustomerPriceGroupRetroactiveScheduleRejected)(removeFailure)).toBe(true);

      const migrateCollector = createActionCollector(
        migrateCustomerPriceGroupAction.descriptor.domainEvents,
        'commerce.customer-context',
        migrateCustomerPriceGroupAction.descriptor.accessEvidencePolicy,
        migrateCustomerPriceGroupAction.descriptor.auditEvidenceSchema,
      );
      const migrateFailure = yield* handleMigrateCustomerPriceGroup(
        {
          effectiveFrom: '2027-01-01T00:00:00.000Z',
          reason: 'Retroactive migration',
          sourcePriceGroupRef: priceGroupRef,
          targetPriceGroupRef: { ...priceGroupRef, resourceId: 'contract-pricing-v2' },
          targets: [
            {
              assignmentRef,
              expectedProfileRevision: 2,
              expectedRevision: 3,
              profile,
            },
          ],
        },
        {
          actionInvocationId: '44444444-4444-4444-8444-444444444443',
          addDomainEvent: migrateCollector.addDomainEvent,
          addOutboxMessage: migrateCollector.addOutboxMessage,
          recordAuditEvidence: migrateCollector.recordAuditEvidence,
          recordDataAccess: migrateCollector.recordDataAccess,
          scope: temporalScope,
          services: {
            catalog: unreachableCatalog,
            now,
            profileValidation: unreachableProfileValidation,
            store: unreachableStore,
          },
        },
      ).pipe(Effect.flip);
      expect(Schema.is(CustomerPriceGroupRetroactiveScheduleRejected)(migrateFailure)).toBe(true);
    }),
  );

  it.effect(
    'threads one validated scheduled instant through profile, catalog, and persistence',
    () =>
      Effect.gen(function* threadsScheduledInstant() {
        const effectiveFrom = '2027-02-01T00:00:00.000Z';
        const recordedAt = '2027-01-01T00:00:00.000Z';
        const observed: string[] = [];
        const collector = collectorFor(assignCustomerPriceGroupAction);
        yield* handleAssignCustomerPriceGroup(
          {
            effectiveFrom,
            expectedProfileRevision: 2,
            priceGroupRef,
            profile,
            reason: 'Scheduled assignment',
          },
          {
            actionInvocationId: '44444444-4444-4444-8444-444444444444',
            addDomainEvent: collector.addDomainEvent,
            addOutboxMessage: collector.addOutboxMessage,
            recordAuditEvidence: collector.recordAuditEvidence,
            recordDataAccess: collector.recordDataAccess,
            scope: temporalScope,
            services: {
              catalog: {
                resolveCurrent: (_ref, _contract, effectiveAt) => {
                  observed.push(`catalog:${effectiveAt}`);
                  return Effect.succeed({
                    _tag: 'USABLE',
                    compatibility: {
                      catalogRevision: 1,
                      contractId: 'commerce.customer-price-group-assignment.v1',
                      contractRevision: 1,
                      definitionRevision: 1,
                    },
                    priceGroupRef,
                  });
                },
              },
              now: Effect.succeed(recordedAt),
              profileValidation: {
                inspect: (_profile, effectiveAt) => {
                  observed.push(`profile:${effectiveAt}`);
                  return Effect.succeed({
                    _tag: 'CURRENT',
                    counterpartyRef: null,
                    revision: 2,
                    state: 'ACTIVE',
                  });
                },
              },
              store: {
                ...unreachableStore,
                assign: (input) => {
                  observed.push(`store:${input.effectiveFrom}:${input.recordedAt}`);
                  return Effect.succeed({
                    _tag: 'assigned',
                    assignment: {
                      assignmentRef,
                      compatibility: input.compatibility,
                      effectiveFrom: input.effectiveFrom,
                      effectiveTo: input.effectiveTo,
                      priceGroupRef: input.priceGroupRef,
                      profile: input.profile,
                      reason: input.reason,
                      recordedAt: input.recordedAt,
                      revision: 1,
                      state: 'ACTIVE',
                    },
                    changed: true,
                    replacedAssignmentRef: null,
                  });
                },
              },
            },
          },
        );
        expect(observed).toEqual([
          `profile:${effectiveFrom}`,
          `catalog:${effectiveFrom}`,
          `store:${effectiveFrom}:${recordedAt}`,
        ]);
      }),
  );

  it.effect('records every Counterparty migration target as contributing Data Access', () =>
    Effect.gen(function* counterpartyMigrationEvidence() {
      const collector = createActionCollector(
        migrateCounterpartyPriceGroupAction.descriptor.domainEvents,
        'commerce.customer-context',
        migrateCounterpartyPriceGroupAction.descriptor.accessEvidencePolicy,
        migrateCounterpartyPriceGroupAction.descriptor.auditEvidenceSchema,
      );
      const accesses: string[] = [];
      const secondProfile = { ...counterpartyProfile, resourceId: 'counterparty-profile-2' };
      const secondAssignmentRef = { ...assignmentRef, resourceId: 'assignment-2' };
      const targetPriceGroupRef = { ...priceGroupRef, resourceId: 'contract-pricing-v2' };
      const result = yield* handleMigrateCounterpartyPriceGroup(
        {
          counterpartyRef,
          effectiveFrom: '2027-02-01T00:00:00.000Z',
          reason: 'Migrate negotiated Counterparty pricing',
          sourcePriceGroupRef: priceGroupRef,
          targetPriceGroupRef,
          targets: [
            {
              assignmentRef,
              expectedProfileRevision: 2,
              expectedRevision: 3,
              profile: counterpartyProfile,
            },
            {
              assignmentRef: secondAssignmentRef,
              expectedProfileRevision: 2,
              expectedRevision: 4,
              profile: secondProfile,
            },
          ],
        },
        {
          actionInvocationId: '44444444-4444-4444-8444-444444444445',
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: (evidence) => {
            accesses.push(evidence.queryHash ?? '');
            return collector.recordDataAccess(evidence);
          },
          scope: temporalScope,
          services: {
            catalog: {
              resolveCurrent: () =>
                Effect.succeed({
                  _tag: 'USABLE',
                  compatibility: {
                    catalogRevision: 1,
                    contractId: 'commerce.customer-price-group-assignment.v1',
                    contractRevision: 1,
                    definitionRevision: 1,
                  },
                  priceGroupRef: targetPriceGroupRef,
                }),
            },
            now: Effect.succeed('2027-01-01T00:00:00.000Z'),
            profileValidation: {
              inspect: () =>
                Effect.succeed({
                  _tag: 'CURRENT',
                  counterpartyRef,
                  revision: 2,
                  state: 'ACTIVE',
                }),
            },
            store: {
              ...unreachableStore,
              migrate: () => Effect.succeed({ _tag: 'applied', assignments: [], changed: false }),
            },
          },
        },
      );
      expect(result).toEqual({ _tag: 'MIGRATED', assignments: [], changed: false });
      expect(accesses).toEqual([
        'counterparty-price-group-migration:counterparty-1:1',
        'counterparty-price-group-migration-target:assignment-1:3',
        'counterparty-price-group-migration-target:assignment-2:4',
        'counterparty-price-group-migration-catalog:contract-pricing-v2:1',
      ]);
    }),
  );
});
