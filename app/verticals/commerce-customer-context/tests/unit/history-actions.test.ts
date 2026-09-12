import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionBusinessPermissionTargetResolver,
  getActionHandler,
  getActionResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { repeatCounterpartyOrderAction } from '../../src/actions/repeat-counterparty-order.action.ts';
import type { RepeatCounterpartyOrderPayload } from '../../src/actions/repeat-counterparty-order.action.ts';
import { repeatRetailOrderAction } from '../../src/actions/repeat-retail-order.action.ts';
import type { RepeatRetailOrderPayload } from '../../src/actions/repeat-retail-order.action.ts';
import {
  HistoryActionUnavailable,
  RepeatOrderConflict,
  RepeatOrderNoRepeatableLines,
} from '../../shared/domain/history-action-errors.ts';
import type { HistoryActionOwnerPorts } from '../../shared/domain/history-action-ports.ts';
import type { CustomerHistoryPorts, HistoricalOrderCandidate } from '../../shared/domain/history-ports.ts';
import type { CustomerHistorySubject } from '../../shared/domain/record-visibility-contracts.ts';
import { handleRepeatRetailOrder } from '../../src/actions/history-action-support.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const now = '2026-09-09T10:00:00.000Z';
const retailProfileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile' as const,
  tenantId,
};
const counterpartyProfileRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const orderRef = {
  moduleId: 'commerce.order',
  resourceId: 'order-1',
  resourceType: 'commerce.order.order',
  tenantId,
};
const cartRef = {
  moduleId: 'commerce.cart',
  resourceId: 'new-cart-1',
  resourceType: 'commerce.cart.cart',
  tenantId,
};
const cartLines = [
  { cartLineRef: 'new-cart-1:line-1', outcome: 'ADDED' as const, sourceLineRef: 'line-1' },
  { outcome: 'SKIPPED' as const, reason: 'PRODUCT_NOT_SELLABLE', sourceLineRef: 'line-2' },
];
const scope = {
  authMethod: 'system' as const,
  correlationId: 'history-action-test',
  legalEntityId,
  principalId,
  tenantId,
};

const makeOrder = (subject: CustomerHistorySubject): HistoricalOrderCandidate => ({
  acceptedAt: '2026-09-01T08:30:00.000Z',
  displayLabel: 'Order 1',
  freshness: { observedAt: now, sourceRevision: 'order-r1', status: 'CURRENT' },
  lines: [
    { productRef: 'product-1', requestedQuantity: '2', sourceLineRef: 'line-1' },
    { productRef: 'product-2', requestedQuantity: '3', sourceLineRef: 'line-2' },
  ],
  orderRef,
  subject,
  submittedByPrincipalId: principalId,
});

const recordTypeFieldAllowlist = {
  detail: ['accepted-currency'],
  download: [],
  list: ['acceptedAt', 'displayLabel', 'freshness', 'occurredAt', 'orderRef', 'recordKind', 'recordRef'],
} as const;
const recordTypeFieldContracts = {
  detail: { name: 'customer-order-history.detail', version: '1' },
  download: null,
  list: { name: 'customer-history.summary', version: '1' },
} as const;
const recordTypeFreshnessPolicy = {
  detail: 'AUTHORITATIVE_CURRENT',
  download: 'AUTHORITATIVE_CURRENT',
  listMaxAgeMilliseconds: 86_400_000,
} as const;

const makePorts = (subject: CustomerHistorySubject): CustomerHistoryPorts => {
  const order = makeOrder(subject);
  return {
    access: {
      counterparty: () =>
        Effect.succeed({
          access: 'CURRENT',
          archivePermission: 'CURRENT',
          historyPermission: 'counterparty.history.read_own',
          policy: 'ALLOWED',
          purchasePermission: 'CURRENT',
        }),
      retail: () =>
        Effect.succeed({
          archivePermission: 'CURRENT',
          binding: 'CURRENT',
          historyPermission: 'CURRENT',
          policy: 'ALLOWED',
          repeatPermission: 'CURRENT',
        }),
    },
    archiveSources: [],
    cart: {
      prepareLine: (_subject, line) =>
        Effect.succeed(
          line.productRef === 'product-1'
            ? {
                currentProductRef: line.productRef,
                requestedQuantity: line.requestedQuantity,
                sourceLineRef: line.sourceLineRef,
                status: 'REPEATABLE' as const,
              }
            : {
                reason: 'PRODUCT_NOT_SELLABLE' as const,
                requestedQuantity: line.requestedQuantity,
                sourceLineRef: line.sourceLineRef,
                status: 'SKIPPED' as const,
              },
        ),
    },
    counterpartyProfiles: { current: () => Effect.succeed('CURRENT') },
    orders: {
      getCustomerFacingDetail: () => Effect.succeed({ outcome: 'NOT_FOUND' as const }),
      getForHistoryDetailAuthorization: () => Effect.succeed({ outcome: 'FOUND' as const, value: order }),
      getForRepeat: () => Effect.succeed({ outcome: 'FOUND' as const, value: order }),
      listCounterparty: () => Effect.succeed([order]),
      listRetail: () => Effect.succeed([order]),
    },
    recordTypes: {
      get: ({ ownerModuleId, resourceType }) =>
        Effect.succeed({
          additionalBusinessPolicies: ['commerce.order.customer-visibility.v1'],
          callerPermissions: ['retail.history.read', 'counterparty.history.read_own', 'counterparty.history.read_all'],
          canonicalOwnerModuleId: ownerModuleId,
          canonicalResourceType: resourceType,
          customerContextRelationship: 'RETAIL_OR_COUNTERPARTY' as const,
          defaultVisibilityState: 'CUSTOMER_HIDDEN' as const,
          exportPolicy: { outcome: 'NOT_SUPPORTED' as const },
          fieldAllowlist: recordTypeFieldAllowlist,
          fieldContracts: recordTypeFieldContracts,
          freshnessPolicy: recordTypeFreshnessPolicy,
          migrationAndReconciliationPolicy: 'preserve exact historical customer references',
          partialFailurePolicy: 'OMIT_PROTECTED_CONTENT_AND_REPORT_TYPED_DEGRADATION' as const,
          retentionVisibilityRelationship: 'INDEPENDENT' as const,
          transitionContract: {
            actionKey: `${ownerModuleId}.change-customer-record-visibility`,
            eventTopic: `${ownerModuleId}.customer-record-visibility-changed.v1`,
            ownerModuleId,
          },
        }),
    },
    resources: { current: () => Effect.succeed('CURRENT') },
    visibility: {
      get: () =>
        Effect.succeed({
          fact: {
            decidedAt: now,
            effectiveFrom: now,
            evidenceRef: { ...orderRef, resourceId: 'visibility-1' },
            fieldSet: { name: 'customer-history.summary', version: '1' },
            freshness: 'CURRENT' as const,
            ownerModuleId: 'commerce.order',
            policyRevision: 'visibility-r1',
            reasonCode: 'ORDER_ACCEPTED_FOR_CUSTOMER',
            recordRef: orderRef,
            sourceRevision: 'visibility-r1',
            state: 'CUSTOMER_VISIBLE' as const,
            subject,
          },
          outcome: 'FOUND' as const,
        }),
    },
  };
};

const collectors = <A extends typeof repeatRetailOrderAction | typeof repeatCounterpartyOrderAction>(action: A) =>
  createActionCollector(
    action.descriptor.domainEvents,
    'commerce.customer-context',
    action.descriptor.accessEvidencePolicy,
    action.descriptor.auditEvidenceSchema,
  );

it('declares exact pre-handler business and Order resource permissions', () => {
  const retailPayload: RepeatRetailOrderPayload = {
    profileRef: retailProfileRef,
    sourceOrderRef: orderRef,
  };
  const counterpartyPayload: RepeatCounterpartyOrderPayload = {
    counterpartyRef,
    profileRef: counterpartyProfileRef,
    sourceOrderRef: orderRef,
    storefrontId: 'storefront-1',
  };
  expect(getActionBusinessPermissionTargetResolver(repeatRetailOrderAction)?.(retailPayload, scope)).toMatchObject({
    permission: 'retail.repeat_order',
    target: { kind: 'retail_profile' },
  });
  expect(
    getActionBusinessPermissionTargetResolver(repeatCounterpartyOrderAction)?.(counterpartyPayload, scope),
  ).toEqual({
    permission: 'counterparty.purchase.prepare',
    target: {
      counterpartyId: counterpartyRef.resourceId,
      kind: 'counterparty_storefront',
      legalEntityId,
      storefrontId: 'storefront-1',
      tenantId,
    },
  });
  expect(
    getActionBusinessPermissionTargetResolver(repeatCounterpartyOrderAction)?.(counterpartyPayload, {
      ...scope,
      trustedStorefrontId: 'gateway-storefront',
    }),
  ).toMatchObject({ trustedStorefrontId: 'gateway-storefront' });
  expect(getActionResourcePermissionTargetResolver(repeatRetailOrderAction)?.(retailPayload, scope)).toEqual({
    permission: 'read',
    resource: orderRef,
  });
});

it.effect('creates a new Cart from only current repeatable intent and preserves line outcomes', () =>
  Effect.gen(function* repeatRetail() {
    const payload: RepeatRetailOrderPayload = {
      profileRef: retailProfileRef,
      sourceOrderRef: orderRef,
    };
    const collector = collectors(repeatRetailOrderAction);
    let ownerInput: unknown;
    const owners: HistoryActionOwnerPorts = {
      carts: {
        createFromHistoricalIntent: (input) => {
          ownerInput = input;
          return Effect.succeed({ cartRef, lines: cartLines, outcome: 'CREATED' });
        },
      },
    };
    const result = yield* handleRepeatRetailOrder(payload, {
      actionInvocationId: 'repeat-invocation-1',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: {
        history: makePorts({ kind: 'RETAIL_PROFILE', profileRef: retailProfileRef }),
        now: Effect.succeed(now),
        owners,
      },
    });

    expect(result.outcome).toBe('CART_CREATED');
    expect(result.cartRef.resourceId).toBe('new-cart-1');
    expect(result.lines).toEqual(cartLines);
    expect(ownerInput).toEqual({
      actionInvocationId: 'repeat-invocation-1',
      lines: [
        {
          currentProductRef: 'product-1',
          requestedQuantity: '2',
          sourceLineRef: 'line-1',
          status: 'REPEATABLE',
        },
        {
          reason: 'PRODUCT_NOT_SELLABLE',
          requestedQuantity: '3',
          sourceLineRef: 'line-2',
          status: 'SKIPPED',
        },
      ],
      repeatIntentKey: 'repeat-order:11111111-1111-4111-8111-111111111111:order-1:retail-profile-1:retail',
      sourceOrderRef: orderRef,
      subject: retailProfileRef,
    });
    expect(ownerInput).not.toHaveProperty('price');
    expect(collector.snapshot().domainEvents).toHaveLength(0);
  }),
);

it.effect('fails closed for cross-tenant and wrong-type Cart ResourceRefs', () =>
  Effect.gen(function* misboundCart() {
    const payload: RepeatRetailOrderPayload = {
      profileRef: retailProfileRef,
      sourceOrderRef: orderRef,
    };
    const malformedCartRefs = [
      {
        ...cartRef,
        tenantId: '44444444-4444-4444-8444-444444444444',
      },
      {
        ...cartRef,
        moduleId: 'commerce.order',
      },
      {
        ...cartRef,
        resourceType: 'commerce.cart.checkout',
      },
    ];

    for (const [index, returnedCartRef] of malformedCartRefs.entries()) {
      const collector = collectors(repeatRetailOrderAction);
      const failure = yield* handleRepeatRetailOrder(payload, {
        actionInvocationId: `misbound-cart-${index}`,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          history: makePorts({ kind: 'RETAIL_PROFILE', profileRef: retailProfileRef }),
          now: Effect.succeed(now),
          owners: {
            carts: {
              createFromHistoricalIntent: () =>
                Effect.succeed({ cartRef: returnedCartRef, lines: cartLines, outcome: 'CREATED' }),
            },
          },
        },
      }).pipe(Effect.flip);

      expect(Schema.is(HistoryActionUnavailable)(failure)).toBe(true);
      expect(collector.snapshot().auditEvidence).toEqual({});
    }
  }),
);

it.effect('returns typed repeat failures for conflict, empty intent, and owner outage', () =>
  Effect.gen(function* repeatFailures() {
    const payload: RepeatRetailOrderPayload = {
      profileRef: retailProfileRef,
      sourceOrderRef: orderRef,
    };
    const run = (history: CustomerHistoryPorts, carts: HistoryActionOwnerPorts['carts']) => {
      const collector = collectors(repeatRetailOrderAction);
      return getActionHandler(repeatRetailOrderAction)(payload, {
        actionInvocationId: 'repeat-failure-invocation',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: {
          history,
          now: Effect.succeed(now),
          owners: { carts },
        },
      });
    };
    const ports = makePorts({ kind: 'RETAIL_PROFILE', profileRef: retailProfileRef });
    const conflict = yield* run(ports, {
      createFromHistoricalIntent: () => Effect.succeed({ outcome: 'CONFLICT' }),
    }).pipe(Effect.flip);
    expect(Schema.is(RepeatOrderConflict)(conflict)).toBe(true);

    const noLines = yield* run(
      {
        ...ports,
        cart: {
          prepareLine: (_subject, line) =>
            Effect.succeed({
              reason: 'PRODUCT_NOT_SELLABLE',
              requestedQuantity: line.requestedQuantity,
              sourceLineRef: line.sourceLineRef,
              status: 'SKIPPED',
            }),
        },
      },
      {
        createFromHistoricalIntent: () => Effect.succeed({ cartRef, lines: cartLines, outcome: 'CREATED' }),
      },
    ).pipe(Effect.flip);
    expect(Schema.is(RepeatOrderNoRepeatableLines)(noLines)).toBe(true);

    const unavailable = yield* run(ports, {
      createFromHistoricalIntent: () =>
        Effect.fail(
          new HistoryActionUnavailable({
            code: 'history_action_unavailable',
            ownerModuleId: 'commerce.cart',
            reason: 'Cart owner unavailable',
          }),
        ),
    }).pipe(Effect.flip);
    expect(Schema.is(HistoryActionUnavailable)(unavailable)).toBe(true);
    if (Schema.is(HistoryActionUnavailable)(unavailable)) {
      expect(unavailable.ownerModuleId).toBe('commerce.cart');
    }
  }),
);

it.effect('rejects untrusted Storefront and mismatched Counterparty profile before owner reads', () =>
  Effect.gen(function* counterpartyTrust() {
    const payload: RepeatCounterpartyOrderPayload = {
      counterpartyRef,
      profileRef: counterpartyProfileRef,
      sourceOrderRef: orderRef,
      storefrontId: 'storefront-request',
    };
    const collector = createActionCollector(
      repeatCounterpartyOrderAction.descriptor.domainEvents,
      'commerce.customer-context',
      repeatCounterpartyOrderAction.descriptor.accessEvidencePolicy,
      repeatCounterpartyOrderAction.descriptor.auditEvidenceSchema,
    );
    let associationCalls = 0;
    const ports = makePorts({
      counterpartyRef,
      kind: 'COUNTERPARTY',
      profileRef: counterpartyProfileRef,
    });
    const guardedPorts: CustomerHistoryPorts = {
      ...ports,
      counterpartyProfiles: {
        current: () => {
          associationCalls += 1;
          return Effect.succeed('ABSENT');
        },
      },
    };
    const run = (trustedStorefrontId?: string) =>
      getActionHandler(repeatCounterpartyOrderAction)(payload, {
        actionInvocationId: 'counterparty-trust-invocation',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: trustedStorefrontId === undefined ? scope : { ...scope, trustedStorefrontId },
        services: {
          history: guardedPorts,
          now: Effect.succeed(now),
          owners: {
            carts: {
              createFromHistoricalIntent: () => Effect.succeed({ cartRef, lines: cartLines, outcome: 'CREATED' }),
            },
          },
        },
      });

    expect(Schema.is(RepeatOrderConflict)(yield* run().pipe(Effect.flip))).toBe(true);
    expect(Schema.is(RepeatOrderConflict)(yield* run('storefront-other').pipe(Effect.flip))).toBe(true);
    expect(associationCalls).toBe(0);

    expect(Schema.is(RepeatOrderConflict)(yield* run('storefront-request').pipe(Effect.flip))).toBe(true);
    expect(associationCalls).toBe(1);
  }),
);
