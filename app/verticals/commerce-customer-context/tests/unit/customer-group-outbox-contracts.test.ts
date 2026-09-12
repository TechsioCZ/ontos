// @effect-diagnostics nodeBuiltinImport:off -- Source-contract assertions protect generated Action attachment seams; expires: 2026-12-31.
import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerGroupSchema,
} from '../../shared/domain/group-contract.ts';
import { CustomerGroupPersistenceUnavailable } from '../../shared/domain/group-errors.ts';
import type { CustomerGroupPersistence } from '../../shared/domain/group-service.ts';
import { OutboxPayloadSchema as CustomerGroupArchivedSchema } from '../../shared/outbox/commerce-customer-context-customer-group-archived-v1.ts';
import { OutboxPayloadSchema as CustomerGroupCreatedSchema } from '../../shared/outbox/commerce-customer-context-customer-group-created-v1.ts';
import { OutboxPayloadSchema as CustomerGroupMembershipAssignedSchema } from '../../shared/outbox/commerce-customer-context-customer-group-membership-assigned-v1.ts';
import {
  OutboxPayloadSchema as CustomerGroupMembershipCancelledSchema,
  outboxTopic as customerGroupMembershipCancelledTopic,
} from '../../shared/outbox/commerce-customer-context-customer-group-membership-cancelled-v1.ts';
import {
  OutboxPayloadSchema as CustomerGroupMembershipEndedSchema,
  outboxTopic as customerGroupMembershipEndedTopic,
} from '../../shared/outbox/commerce-customer-context-customer-group-membership-ended-v1.ts';
import { OutboxPayloadSchema as CustomerGroupReactivatedSchema } from '../../shared/outbox/commerce-customer-context-customer-group-reactivated-v1.ts';
import { OutboxPayloadSchema as CustomerGroupUpdatedSchema } from '../../shared/outbox/commerce-customer-context-customer-group-updated-v1.ts';
import { createArchiveCustomerGroupCommerceCustomerContextCustomerGroupArchivedV1OutboxMessage as createArchivedMessage } from '../../src/actions/archive-customer-group.commerce-customer-context-customer-group-archived-v1.outbox-message.ts';
import { createAssignCustomerGroupCommerceCustomerContextCustomerGroupMembershipAssignedV1OutboxMessage as createAssignedMessage } from '../../src/actions/assign-customer-group.commerce-customer-context-customer-group-membership-assigned-v1.outbox-message.ts';
import { createCreateCustomerGroupCommerceCustomerContextCustomerGroupCreatedV1OutboxMessage as createCreatedMessage } from '../../src/actions/create-customer-group.commerce-customer-context-customer-group-created-v1.outbox-message.ts';
import {
  CreateCustomerGroupPayloadSchema,
  createCustomerGroupAction,
} from '../../src/actions/create-customer-group.action.ts';
import { createReactivateCustomerGroupCommerceCustomerContextCustomerGroupReactivatedV1OutboxMessage as createReactivatedMessage } from '../../src/actions/reactivate-customer-group.commerce-customer-context-customer-group-reactivated-v1.outbox-message.ts';
import { createRemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipCancelledV1OutboxMessage as createCancelledMessage } from '../../src/actions/remove-customer-group.commerce-customer-context-customer-group-membership-cancelled-v1.outbox-message.ts';
import { createRemoveCustomerGroupCommerceCustomerContextCustomerGroupMembershipEndedV1OutboxMessage as createEndedMessage } from '../../src/actions/remove-customer-group.commerce-customer-context-customer-group-membership-ended-v1.outbox-message.ts';
import { removeCustomerGroupAction } from '../../src/actions/remove-customer-group.action.ts';
import { createUpdateCustomerGroupCommerceCustomerContextCustomerGroupUpdatedV1OutboxMessage as createUpdatedMessage } from '../../src/actions/update-customer-group.commerce-customer-context-customer-group-updated-v1.outbox-message.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const groupRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group',
  tenantId,
} as const;
const membershipRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.customer-group-membership',
  tenantId,
} as const;
const profile = {
  profileKind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '50000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const createdAt = '2026-09-09T10:00:00.000Z';
const endedAt = '2026-09-10T10:00:00.000Z';
const cancelledAt = '2026-09-08T10:00:00.000Z';
const initialDefinition = {
  changeKind: 'CREATED',
  description: 'Staff-facing explanation of the stable launch segment',
  membershipCriteria: 'Customers qualifying under the durable launch criteria',
  name: 'Launch customers',
  purpose: 'Represent the stable launch customer segment',
  reason: 'Initial definition',
  recordedAt: createdAt,
  revision: 1,
} as const;
const revisedDefinition = {
  ...initialDefinition,
  changeKind: 'COSMETIC_RENAME',
  name: 'Launch customer group',
  reason: 'Clarify the displayed name',
  revision: 2,
} as const;
const group = Schema.decodeUnknownSync(CommerceCustomerGroupSchema)({
  businessCode: 'LAUNCH_CUSTOMERS',
  currentDefinition: revisedDefinition,
  currentState: 'ACTIVE',
  definitionHistory: [initialDefinition, revisedDefinition],
  groupRef,
  lifecycleHistory: [
    {
      activeFrom: createdAt,
      archivedAt: null,
      reason: 'Initial activation',
      recordedAt: createdAt,
    },
  ],
  meaningKey: 'customer.launch',
  revision: 2,
});
const assignedMembership = Schema.decodeUnknownSync(CommerceCustomerGroupMembershipSchema)({
  assignedAt: createdAt,
  assignmentReason: 'Qualifies under the launch criteria',
  effectiveFrom: createdAt,
  effectiveTo: null,
  groupRef,
  membershipRef,
  profile,
  removal: null,
  revision: 1,
  state: 'VALID',
});
const endedMembership = Schema.decodeUnknownSync(CommerceCustomerGroupMembershipSchema)({
  ...assignedMembership,
  effectiveTo: endedAt,
  removal: {
    effectiveAt: endedAt,
    kind: 'EXPLICIT_END',
    reason: 'Customer no longer qualifies',
    recordedAt: endedAt,
  },
  revision: 2,
});
const cancelledMembership = Schema.decodeUnknownSync(CommerceCustomerGroupMembershipSchema)({
  ...assignedMembership,
  removal: {
    effectiveAt: cancelledAt,
    kind: 'EXPLICIT_CANCEL',
    reason: 'Future assignment was entered in error',
    recordedAt: createdAt,
  },
  revision: 2,
  state: 'CANCELLED',
});

const createdPayload = {
  businessCode: group.businessCode,
  definition: initialDefinition,
  groupRef: group.groupRef,
  meaningKey: group.meaningKey,
  revision: 1,
};
const updatedPayload = {
  afterDefinition: revisedDefinition,
  beforeDefinition: initialDefinition,
  groupRef: group.groupRef,
  revision: group.revision,
};
const archivedPayload = {
  cancelledMembershipCount: 2,
  effectiveAt: endedAt,
  endedMembershipCount: 3,
  groupRef: group.groupRef,
  recordedAt: endedAt,
  revision: 3,
};
const reactivatedPayload = {
  effectiveAt: endedAt,
  groupRef: group.groupRef,
  recordedAt: endedAt,
  revision: 4,
};
const assignedPayload = { membership: assignedMembership };
const endedPayload = { membership: endedMembership };
const cancelledPayload = { membership: cancelledMembership };

it('uses exact bounded schemas for all seven customer-group owner messages', () => {
  const cases = [
    [CustomerGroupCreatedSchema, createdPayload],
    [CustomerGroupUpdatedSchema, updatedPayload],
    [CustomerGroupArchivedSchema, archivedPayload],
    [CustomerGroupReactivatedSchema, reactivatedPayload],
    [CustomerGroupMembershipAssignedSchema, assignedPayload],
    [CustomerGroupMembershipEndedSchema, endedPayload],
    [CustomerGroupMembershipCancelledSchema, cancelledPayload],
  ] as const;
  for (const [schema, payload] of cases) {
    expect(Schema.is(schema)(payload)).toBe(true);
    expect(Schema.is(schema)({ data: payload })).toBe(false);
  }
  expect(Schema.is(CustomerGroupMembershipAssignedSchema)(endedPayload)).toBe(false);
  expect(Schema.is(CustomerGroupMembershipEndedSchema)(cancelledPayload)).toBe(false);
  expect(Schema.is(CustomerGroupMembershipCancelledSchema)(endedPayload)).toBe(false);
});

it('builds seven distinct owner messages without generic data envelopes', () => {
  const messages = [
    createCreatedMessage(createdPayload),
    createUpdatedMessage(updatedPayload),
    createArchivedMessage(archivedPayload),
    createReactivatedMessage(reactivatedPayload),
    createAssignedMessage(assignedPayload),
    createEndedMessage(endedPayload),
    createCancelledMessage(cancelledPayload),
  ];
  expect(new Set(messages.map(({ topic }) => topic)).size).toBe(7);
  expect(messages.map(({ payloadJson }) => payloadJson)).toEqual([
    createdPayload,
    updatedPayload,
    archivedPayload,
    reactivatedPayload,
    assignedPayload,
    endedPayload,
    cancelledPayload,
  ]);
  for (const message of messages) {
    expect(message.producerModuleKey).toBe('commerce.customer-context');
  }
});

it('attaches every generated message to its returned Domain Event only inside a material-change branch', () => {
  const actionSources = [
    ['create-customer-group.action.ts', 'if (resolved.created) {'],
    ['assign-customer-group.action.ts', 'if (resolved.created) {'],
    ['remove-customer-group.action.ts', 'if (resolved.changed) {'],
  ] as const;
  for (const [file, changedBranch] of actionSources) {
    const source = readFileSync(new URL(`../../src/actions/${file}`, import.meta.url), {
      encoding: 'utf-8',
    });
    expect(source).toContain(changedBranch);
    expect(source).toContain('const event = yield* context.addDomainEvent({');
    expect(source).toContain('yield* context.addOutboxMessage(');
    expect(source).toContain('event,');
    expect(source.match(/context\.addOutboxMessage\(/gu)).toHaveLength(1);
  }

  const delegatedActionSources = [
    ['archive-customer-group.action.ts', 'outboxMessage: createCustomerGroupArchivedOutboxMessage'],
    ['reactivate-customer-group.action.ts', 'outboxMessage: createCustomerGroupReactivatedOutboxMessage'],
    ['update-customer-group.action.ts', 'outboxMessage: createCustomerGroupUpdatedOutboxMessage'],
  ] as const;
  for (const [file, outboxMessageBinding] of delegatedActionSources) {
    const source = readFileSync(new URL(`../../src/actions/${file}`, import.meta.url), {
      encoding: 'utf-8',
    });
    expect(source).toContain('executeCustomerGroupAction(payload, context, {');
    expect(source).toContain(outboxMessageBinding);
  }

  const sharedHandlerSource = readFileSync(
    new URL('../../src/actions/customer-group-action-handler.ts', import.meta.url),
    { encoding: 'utf-8' },
  );
  expect(sharedHandlerSource).toContain('if (resolved.changed) {');
  expect(sharedHandlerSource).toContain('const event = yield* context.addDomainEvent({');
  expect(sharedHandlerSource).toContain('yield* context.addOutboxMessage(event,');
  expect(sharedHandlerSource.match(/context\.addOutboxMessage\(/gu)).toHaveLength(1);
});

it('composes the governed transaction adapter for both Action and Read services', () => {
  const source = readFileSync(new URL('../../src/actions/customer-group-action-support.ts', import.meta.url), {
    encoding: 'utf-8',
  });
  expect(source).toContain(
    "import { customerGroupPersistenceForTransaction } from '../persistence/group-persistence.ts';",
  );
  expect(source).toContain('customerGroupPersistenceForTransaction(transaction, { ...scope, legalEntityId })');
  expect(source).not.toContain('failClosedCustomerGroupPersistence');
});

const persistenceUnavailable = () =>
  new CustomerGroupPersistenceUnavailable({
    code: 'customer_group_persistence_unavailable',
    reason: 'Unused persistence operation in the focused Action attachment test',
  });

const unavailablePersistence: CustomerGroupPersistence = {
  archive: () => Effect.fail(persistenceUnavailable()),
  assign: () => Effect.fail(persistenceUnavailable()),
  create: () => Effect.fail(persistenceUnavailable()),
  detail: () => Effect.fail(persistenceUnavailable()),
  effectiveMemberships: () => Effect.fail(persistenceUnavailable()),
  history: () => Effect.fail(persistenceUnavailable()),
  members: () => Effect.fail(persistenceUnavailable()),
  reactivate: () => Effect.fail(persistenceUnavailable()),
  remove: () => Effect.fail(persistenceUnavailable()),
  update: () => Effect.fail(persistenceUnavailable()),
};

it.effect('records bounded audit evidence for a maximum-size valid group definition', () =>
  Effect.gen(function* maximumCustomerGroupDefinitionAudit() {
    const maximumText = 'x'.repeat(4000);
    const maximumDefinition = {
      changeKind: 'CREATED' as const,
      description: maximumText,
      membershipCriteria: maximumText,
      name: 'Maximum definition',
      purpose: maximumText,
      reason: 'Create a maximum-size definition',
      recordedAt: createdAt,
      revision: 1,
    };
    const maximumGroup = Schema.decodeUnknownSync(CommerceCustomerGroupSchema)({
      ...group,
      currentDefinition: maximumDefinition,
      definitionHistory: [maximumDefinition],
      revision: 1,
    });
    const payload = Schema.decodeUnknownSync(CreateCustomerGroupPayloadSchema)({
      businessCode: maximumGroup.businessCode,
      description: maximumText,
      initialState: 'ACTIVE',
      meaningKey: maximumGroup.meaningKey,
      membershipCriteria: maximumText,
      name: maximumDefinition.name,
      purpose: maximumText,
      reason: maximumDefinition.reason,
    });
    const collector = createActionCollector(
      createCustomerGroupAction.descriptor.domainEvents,
      'commerce.customer-context',
      createCustomerGroupAction.descriptor.accessEvidencePolicy,
      createCustomerGroupAction.descriptor.auditEvidenceSchema,
    );
    yield* getActionHandler(createCustomerGroupAction)(payload, {
      actionInvocationId: '60000000-0000-4000-8000-000000000002',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope: {
        authMethod: 'system',
        correlationId: 'customer-group-maximum-definition',
        legalEntityId,
        principalId: '70000000-0000-4000-8000-000000000001',
        tenantId,
      },
      services: {
        ...unavailablePersistence,
        create: () => Effect.succeed({ _tag: 'created', group: maximumGroup }),
      },
    });
    const evidence = collector.snapshot();
    expect(JSON.stringify(evidence.auditEvidence).length).toBeLessThan(4096);
    expect(evidence.auditEvidence).toMatchObject({
      afterDefinitionRevision: 1,
      definitionChangeKind: 'CREATED',
    });
  }),
);

const collectRemoval = (membership: typeof CommerceCustomerGroupMembershipSchema.Type, changed: boolean) =>
  Effect.gen(function* collectCustomerGroupRemoval() {
    const collector = createActionCollector(
      removeCustomerGroupAction.descriptor.domainEvents,
      'commerce.customer-context',
      removeCustomerGroupAction.descriptor.accessEvidencePolicy,
      removeCustomerGroupAction.descriptor.auditEvidenceSchema,
    );
    yield* getActionHandler(removeCustomerGroupAction)(
      {
        effectiveAt: membership.removal?.effectiveAt ?? endedAt,
        groupRef: membership.groupRef,
        membershipRef: membership.membershipRef,
        profile: membership.profile,
        reason: 'End exact customer-group membership',
      },
      {
        actionInvocationId: '60000000-0000-4000-8000-000000000001',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'customer-group-removal-contract',
          legalEntityId,
          principalId: '70000000-0000-4000-8000-000000000001',
          tenantId,
        },
        services: {
          ...unavailablePersistence,
          remove: () => Effect.succeed({ _tag: 'removed', changed, membership }),
        },
      },
    );
    return collector.snapshot();
  });

it.effect('selects the removal topic from persisted state and emits nothing on replay', () =>
  Effect.gen(function* customerGroupRemovalAttachment() {
    const endedEvidence = yield* collectRemoval(endedMembership, true);
    expect(endedEvidence.domainEvents).toHaveLength(1);
    expect(endedEvidence.outboxMessages).toHaveLength(1);
    expect(endedEvidence.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(endedEvidence.outboxMessages[0]?.message.topic).toBe(customerGroupMembershipEndedTopic);

    const cancelledEvidence = yield* collectRemoval(cancelledMembership, true);
    expect(cancelledEvidence.domainEvents).toHaveLength(1);
    expect(cancelledEvidence.outboxMessages).toHaveLength(1);
    expect(cancelledEvidence.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(cancelledEvidence.outboxMessages[0]?.message.topic).toBe(customerGroupMembershipCancelledTopic);

    const replayEvidence = yield* collectRemoval(endedMembership, false);
    expect(replayEvidence.domainEvents).toHaveLength(0);
    expect(replayEvidence.outboxMessages).toHaveLength(0);
  }),
);
