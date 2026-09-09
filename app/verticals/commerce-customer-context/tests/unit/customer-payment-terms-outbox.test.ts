import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  CustomerPaymentTermsChangedEventSchema,
  handleChangeCustomerPaymentTerms,
  changeCustomerPaymentTermsAction,
} from '../../src/actions/change-customer-payment-terms.action.ts';
import {
  CustomerPaymentTermRemovedEventSchema,
  handleRemoveCustomerPaymentTerm,
  removeCustomerPaymentTermAction,
} from '../../src/actions/remove-customer-payment-term.action.ts';
import { OutboxPayloadSchema as ChangedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-customer-payment-terms-changed-v1.ts';
import { OutboxPayloadSchema as RemovedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-customer-payment-term-removed-v1.ts';
import { OutboxPayloadSchema as RetailOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-retail-payment-term-preference-changed-v1.ts';
import type { CustomerPaymentTermsState } from '../../shared/domain/payment-term-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const profileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const entitlementRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.customer-context.customer-payment-term-entitlement' as const,
  tenantId,
};
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
};
const state: CustomerPaymentTermsState = {
  entitlements: [],
  preferences: [],
  profileRef,
  revision: 5,
};
const scope = {
  authMethod: 'system' as const,
  correlationId: 'customer-payment-terms-outbox',
  legalEntityId: '66666666-6666-4666-8666-666666666666',
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
};

it('uses exact safe payloads instead of generic data envelopes', () => {
  const changedPayload = {
    action: 'CHANGED' as const,
    changed: true as const,
    changes: [{ _tag: 'CLEAR_PREFERENCE' as const, effectiveAt: '2026-09-09T10:00:00.000Z' }],
    effectiveAt: '2026-09-09T10:00:00.000Z',
    profileRef,
    revision: 5,
  };
  expect(Schema.is(ChangedOutboxPayloadSchema)(changedPayload)).toBe(true);
  expect(Schema.is(CustomerPaymentTermsChangedEventSchema)(changedPayload)).toBe(true);
  expect(
    Schema.is(RemovedOutboxPayloadSchema)({
      effectiveAt: changedPayload.effectiveAt,
      entitlementRef,
      preferenceCleared: false,
      profileRef,
      removalKind: 'ENDED',
      revision: 5,
    }),
  ).toBe(true);
  expect(
    Schema.is(CustomerPaymentTermRemovedEventSchema)({
      effectiveAt: changedPayload.effectiveAt,
      entitlementRef,
      preferenceCleared: false,
      profileRef,
      removalKind: 'ENDED',
      revision: 5,
    }),
  ).toBe(true);
  expect(
    Schema.is(RetailOutboxPayloadSchema)({
      action: 'SET_PREFERENCE',
      effectiveAt: changedPayload.effectiveAt,
      paymentTermRef,
      profileRef: {
        ...profileRef,
        resourceType: 'commerce.customer-context.retail-customer-profile',
      },
      revision: 5,
    }),
  ).toBe(true);
  for (const schema of [
    ChangedOutboxPayloadSchema,
    RemovedOutboxPayloadSchema,
    RetailOutboxPayloadSchema,
  ]) {
    expect(Schema.is(schema)({ data: { arbitrary: true } })).toBe(false);
  }
});

it.effect('attaches one outbox message to each material Counterparty event', () =>
  Effect.gen(function* attachesCounterpartyOutbox() {
    const changedCollector = createActionCollector(
      changeCustomerPaymentTermsAction.descriptor.domainEvents,
      'commerce.customer-context',
      changeCustomerPaymentTermsAction.descriptor.accessEvidencePolicy,
      changeCustomerPaymentTermsAction.descriptor.auditEvidenceSchema,
    );
    yield* handleChangeCustomerPaymentTerms(
      {
        changes: [{ _tag: 'CLEAR_PREFERENCE', effectiveAt: '2026-09-09T10:00:00.000Z' }],
        counterpartyRef,
        expectedRevision: 4,
        profileRef,
        reason: 'Customer request',
      },
      {
        actionInvocationId: '88888888-8888-4888-8888-888888888888',
        addDomainEvent: changedCollector.addDomainEvent,
        addOutboxMessage: changedCollector.addOutboxMessage,
        recordAuditEvidence: changedCollector.recordAuditEvidence,
        recordDataAccess: changedCollector.recordDataAccess,
        scope,
        services: { change: () => Effect.succeed({ changed: true, state }) },
      },
    );
    expect(changedCollector.snapshot().domainEvents).toHaveLength(1);
    expect(changedCollector.snapshot().outboxMessages).toHaveLength(1);
    expect(changedCollector.snapshot().outboxMessages[0]?.domainEventIndex).toBe(0);

    const removedCollector = createActionCollector(
      removeCustomerPaymentTermAction.descriptor.domainEvents,
      'commerce.customer-context',
      removeCustomerPaymentTermAction.descriptor.accessEvidencePolicy,
      removeCustomerPaymentTermAction.descriptor.auditEvidenceSchema,
    );
    yield* handleRemoveCustomerPaymentTerm(
      {
        counterpartyRef,
        effectiveAt: '2026-09-09T10:00:00.000Z',
        entitlementRef,
        expectedRevision: 4,
        profileRef,
        reason: 'Customer request',
      },
      {
        actionInvocationId: '99999999-9999-4999-8999-999999999999',
        addDomainEvent: removedCollector.addDomainEvent,
        addOutboxMessage: removedCollector.addOutboxMessage,
        recordAuditEvidence: removedCollector.recordAuditEvidence,
        recordDataAccess: removedCollector.recordDataAccess,
        scope,
        services: {
          remove: () =>
            Effect.succeed({
              changed: true,
              preferenceCleared: false,
              removalKind: 'ENDED',
              state,
            }),
        },
      },
    );
    expect(removedCollector.snapshot().domainEvents).toHaveLength(1);
    expect(removedCollector.snapshot().outboxMessages).toHaveLength(1);
    expect(removedCollector.snapshot().outboxMessages[0]?.domainEventIndex).toBe(0);
  }),
);

it.effect('records each canonical Payment Term catalog read that governs a successful grant', () =>
  Effect.gen(function* recordsCatalogEvidence() {
    const collector = createActionCollector(
      changeCustomerPaymentTermsAction.descriptor.domainEvents,
      'commerce.customer-context',
      changeCustomerPaymentTermsAction.descriptor.accessEvidencePolicy,
      changeCustomerPaymentTermsAction.descriptor.auditEvidenceSchema,
    );
    yield* handleChangeCustomerPaymentTerms(
      {
        changes: [
          {
            _tag: 'GRANT_ENTITLEMENT',
            effectiveFrom: '2026-09-09T10:00:00.000Z',
            entitlementRef,
            paymentTermRef,
            semanticRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        ],
        counterpartyRef,
        expectedRevision: 4,
        profileRef,
        reason: 'Grant approved terms',
      },
      {
        actionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: { change: () => Effect.succeed({ changed: true, state }) },
      },
    );

    expect(collector.snapshot().dataAccessEvents).toHaveLength(2);
    expect(collector.snapshot().dataAccessEvents[1]).toMatchObject({
      targetModuleKey: paymentTermRef.moduleId,
      targetResourceId: paymentTermRef.resourceId,
      targetResourceType: paymentTermRef.resourceType,
    });
  }),
);

it.effect('does not publish a Counterparty event or outbox message for an unchanged retry', () =>
  Effect.gen(function* skipsUnchangedRetry() {
    const collector = createActionCollector(
      changeCustomerPaymentTermsAction.descriptor.domainEvents,
      'commerce.customer-context',
      changeCustomerPaymentTermsAction.descriptor.accessEvidencePolicy,
      changeCustomerPaymentTermsAction.descriptor.auditEvidenceSchema,
    );
    yield* handleChangeCustomerPaymentTerms(
      {
        changes: [{ _tag: 'CLEAR_PREFERENCE', effectiveAt: '2026-09-09T10:00:00.000Z' }],
        counterpartyRef,
        expectedRevision: 5,
        profileRef,
        reason: 'Equivalent retry',
      },
      {
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: { change: () => Effect.succeed({ changed: false, state }) },
      },
    );
    expect(collector.snapshot().domainEvents).toHaveLength(0);
    expect(collector.snapshot().outboxMessages).toHaveLength(0);
  }),
);
