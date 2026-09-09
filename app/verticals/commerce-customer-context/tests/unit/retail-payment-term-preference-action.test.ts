import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionBusinessPermissionTargetResolver,
  getActionHandler,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  ChangeRetailPaymentTermPreferencePayloadSchema,
  changeRetailPaymentTermPreferenceAction,
} from '../../src/actions/change-retail-payment-term-preference.action.ts';
import type { CustomerPaymentTermsState } from '../../shared/domain/payment-term-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const profileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
};
const entitlementRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.customer-context.customer-payment-term-entitlement' as const,
  tenantId,
};
const payload = {
  change: {
    _tag: 'SET_PREFERENCE' as const,
    effectiveFrom: '2026-09-09T12:00:00.000Z',
    paymentTermRef,
  },
  expectedRevision: 4,
  profileRef,
};
const scope = {
  authMethod: 'system' as const,
  correlationId: 'retail-preference-change',
  legalEntityId: '55555555-5555-4555-8555-555555555555',
  principalId: '66666666-6666-4666-8666-666666666666',
  tenantId,
};

const state: CustomerPaymentTermsState = {
  entitlements: [
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      entitlementRef,
      paymentTermRef,
      semanticRevisionId: 'immediate-v1',
      status: 'ACTIVE',
    },
  ],
  preferences: [
    {
      effectiveFrom: payload.change.effectiveFrom,
      paymentTermRef,
    },
  ],
  profileRef,
  revision: 5,
};

it('accepts preference changes only and declares the exact retail profile permission', () => {
  expect(Schema.is(ChangeRetailPaymentTermPreferencePayloadSchema)(payload)).toBe(true);
  expect(
    Schema.is(ChangeRetailPaymentTermPreferencePayloadSchema)({
      ...payload,
      change: {
        _tag: 'CLEAR_PREFERENCE',
        effectiveAt: payload.change.effectiveFrom,
      },
    }),
  ).toBe(true);
  expect(
    Schema.is(ChangeRetailPaymentTermPreferencePayloadSchema)({
      ...payload,
      change: {
        _tag: 'GRANT_ENTITLEMENT',
        effectiveFrom: payload.change.effectiveFrom,
        entitlementRef,
        paymentTermRef,
        semanticRevisionId: 'immediate-v1',
      },
    }),
  ).toBe(false);

  const resolvePermission = getActionBusinessPermissionTargetResolver(
    changeRetailPaymentTermPreferenceAction,
  );
  expect(
    resolvePermission?.(payload, {
      ...scope,
      correlationId: 'retail-preference-permission',
    }),
  ).toEqual({
    permission: 'retail.settings.payment_term_preference.manage',
    target: {
      kind: 'retail_profile',
      legalEntityId: '55555555-5555-4555-8555-555555555555',
      profileId: profileRef.resourceId,
      tenantId,
    },
  });
});

it.effect('delegates entitlement validation atomically and records a changed preference', () =>
  Effect.gen(function* changePreference() {
    const collector = createActionCollector(
      changeRetailPaymentTermPreferenceAction.descriptor.domainEvents,
      'commerce.customer-context',
      changeRetailPaymentTermPreferenceAction.descriptor.accessEvidencePolicy,
      changeRetailPaymentTermPreferenceAction.descriptor.auditEvidenceSchema,
    );
    let delegatedPayload: unknown;
    const result = yield* getActionHandler(changeRetailPaymentTermPreferenceAction)(payload, {
      actionInvocationId: '77777777-7777-4777-8777-777777777777',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: {
        changePreference: (received) => {
          delegatedPayload = received;
          return Effect.succeed({ changed: true, state });
        },
      },
    });

    expect(delegatedPayload).toEqual(payload);
    expect(result).toEqual({ changed: true, state });
    const evidence = collector.snapshot();
    expect(evidence.auditEvidence).toEqual({
      changed: true,
      changeType: 'SET_PREFERENCE',
      effectiveAt: payload.change.effectiveFrom,
      expectedRevision: 4,
      paymentTermId: paymentTermRef.resourceId,
      profileId: profileRef.resourceId,
      resultRevision: 5,
    });
    expect(evidence.dataAccessEvents).toHaveLength(2);
    expect(evidence.dataAccessEvents[1]).toMatchObject({
      targetModuleKey: paymentTermRef.moduleId,
      targetResourceId: paymentTermRef.resourceId,
      targetResourceType: paymentTermRef.resourceType,
    });
    expect(evidence.domainEvents).toHaveLength(1);
    expect(evidence.outboxMessages).toHaveLength(1);
    expect(evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(evidence.outboxMessages[0]?.message.topic).toBe(
      'commerce.customer-context.retail-payment-term-preference-changed.v1',
    );
    expect(evidence.domainEvents[0]?.eventType).toBe(
      'commerce.customer-context.retail-payment-term-preference-changed.v1',
    );
    expect(evidence.domainEvents[0]?.payloadJson).toEqual({
      action: 'SET_PREFERENCE',
      effectiveAt: payload.change.effectiveFrom,
      paymentTermRef,
      profileRef,
      revision: 5,
    });
  }),
);
