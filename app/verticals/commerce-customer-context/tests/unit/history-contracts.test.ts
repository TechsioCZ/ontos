import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  composeCounterpartyAllOrderHistory,
  composeCounterpartyAllCustomerArchive,
  composeCounterpartyOrderHistory,
  composeCustomerArchive,
  composeRetailOrderHistoryDetail,
  composeRetailOrderHistory,
  prepareRepeatOrder,
  resolveCustomerRecordVisibility,
} from '../../shared/domain/history-composition.ts';
import type {
  CustomerHistoryPorts,
  HistoricalOrderCandidate,
} from '../../shared/domain/history-ports.ts';
import {
  HistoryAccessDenied,
  HistoryOwnerUnavailable,
  HistoryRecordNotFound,
} from '../../shared/domain/history-errors.ts';
import {
  CustomerRecordTypeOnboardingSchema,
  evaluateCustomerRecordVisibility,
} from '../../shared/domain/record-visibility-contracts.ts';
import type {
  CustomerHistorySubject,
  CustomerRecordVisibilityFact,
} from '../../shared/domain/record-visibility-contracts.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
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
const retailSubject = { kind: 'RETAIL_PROFILE' as const, profileRef: retailProfileRef };
const counterpartySubject = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: 'counterparty-1',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
  profileRef: counterpartyProfileRef,
};
const principalId = 'principal-1';
const now = '2026-09-09T10:00:00.000Z';

const orderRef = (resourceId: string) => ({
  moduleId: 'commerce.order',
  resourceId,
  resourceType: 'commerce.order.order',
  tenantId,
});

const visibleFact = (
  resourceId: string,
  subject: CustomerHistorySubject = retailSubject,
): CustomerRecordVisibilityFact => ({
  decidedAt: '2026-09-08T10:00:00.000Z',
  effectiveFrom: '2026-09-08T10:00:00.000Z',
  evidenceRef: {
    moduleId: 'commerce.order',
    resourceId: `visibility-evidence-${resourceId}`,
    resourceType: 'commerce.order.visibility-evidence',
    tenantId,
  },
  fieldSet: { name: 'customer-history.summary', version: '1' },
  freshness: 'CURRENT',
  ownerModuleId: 'commerce.order',
  policyRevision: 'order-visibility-v1',
  reasonCode: 'ORDER_ACCEPTED_FOR_CUSTOMER',
  recordRef: orderRef(resourceId),
  sourceRevision: `visibility-${resourceId}-1`,
  state: 'CUSTOMER_VISIBLE',
  subject,
});

const historicalOrder = (
  resourceId: string,
  submittedByPrincipalId: string,
  subject: CustomerHistorySubject = retailSubject,
): HistoricalOrderCandidate => ({
  acceptedAt: '2026-09-01T08:30:00.000Z',
  displayLabel: `Order ${resourceId}`,
  freshness: {
    observedAt: '2026-09-09T09:59:00.000Z',
    sourceRevision: `revision-${resourceId}`,
    status: 'CURRENT',
  },
  lines: [
    {
      configurationRef: 'configuration-1',
      productRef: 'product-1',
      requestedQuantity: '2',
      sourceLineRef: `${resourceId}:line-1`,
    },
  ],
  orderRef: orderRef(resourceId),
  subject,
  submittedByPrincipalId,
});

const makePorts = (orders: readonly HistoricalOrderCandidate[]): CustomerHistoryPorts => ({
  access: {
    counterparty: () =>
      Effect.succeed({
        access: 'CURRENT',
        archivePermission: 'CURRENT',
        historyPermission: 'counterparty.history.read_all',
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
  archiveSources: [
    {
      list: () =>
        Effect.succeed(
          orders.map((order) => ({
            displayLabel: order.displayLabel,
            freshness: order.freshness,
            occurredAt: order.acceptedAt,
            recordKind: 'ORDER' as const,
            recordRef: order.orderRef,
            subject: order.subject,
            submittedByPrincipalId: order.submittedByPrincipalId,
          })),
        ),
      ownerModuleId: 'commerce.order',
    },
  ],
  cart: {
    prepareLine: (_subject, line) =>
      Effect.succeed({
        currentProductRef: line.productRef,
        requestedQuantity: line.requestedQuantity,
        sourceLineRef: line.sourceLineRef,
        status: 'REPEATABLE' as const,
      }),
  },
  counterpartyProfiles: { current: () => Effect.succeed('CURRENT') },
  orders: {
    getCustomerFacingDetail: () => Effect.succeed({ outcome: 'NOT_FOUND' }),
    getForHistoryDetailAuthorization: ({ orderRef: requestedOrderRef }) => {
      const order = orders.find(
        (candidate) => candidate.orderRef.resourceId === requestedOrderRef.resourceId,
      );
      return Effect.succeed(
        order === undefined
          ? { outcome: 'NOT_FOUND' as const }
          : { outcome: 'FOUND' as const, value: order },
      );
    },
    getForRepeat: ({ orderRef: requestedOrderRef }) => {
      const order = orders.find(
        (candidate) => candidate.orderRef.resourceId === requestedOrderRef.resourceId,
      );
      return Effect.succeed(
        order === undefined
          ? { outcome: 'NOT_FOUND' as const }
          : { outcome: 'FOUND' as const, value: order },
      );
    },
    listCounterparty: () => Effect.succeed(orders),
    listRetail: () => Effect.succeed(orders),
  },
  recordTypes: {
    get: ({ ownerModuleId, resourceType }) =>
      Effect.succeed({
        additionalBusinessPolicies: ['commerce.order.customer-visibility.v1'],
        callerPermissions: [
          'retail.history.read',
          'counterparty.history.read_own',
          'counterparty.history.read_all',
        ],
        canonicalOwnerModuleId: ownerModuleId,
        canonicalResourceType: resourceType,
        customerContextRelationship: 'RETAIL_OR_COUNTERPARTY' as const,
        defaultVisibilityState: 'CUSTOMER_HIDDEN' as const,
        exportPolicy: { outcome: 'NOT_SUPPORTED' as const },
        fieldAllowlist: {
          detail: ['accepted-currency'],
          download: [],
          list: [
            'acceptedAt',
            'displayLabel',
            'freshness',
            'occurredAt',
            'orderRef',
            'recordKind',
            'recordRef',
          ],
        },
        fieldContracts: {
          detail: { name: 'customer-order-history.detail', version: '1' },
          download: null,
          list: { name: 'customer-history.summary', version: '1' },
        },
        freshnessPolicy: {
          detail: 'AUTHORITATIVE_CURRENT' as const,
          download: 'AUTHORITATIVE_CURRENT' as const,
          listMaxAgeMilliseconds: 86_400_000,
        },
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
    get: ({ recordRef, subject }) =>
      Effect.succeed({
        fact: visibleFact(recordRef.resourceId, subject),
        outcome: 'FOUND',
      }),
  },
});

it('fails closed when visibility is missing, hidden, restricted, or indeterminate', () => {
  expect(
    evaluateCustomerRecordVisibility({
      fact: null,
      now,
      recordRef: orderRef('order-1'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'DENIED', reason: 'VISIBILITY_MISSING' });
  expect(
    evaluateCustomerRecordVisibility({
      fact: { ...visibleFact('order-1'), state: 'CUSTOMER_HIDDEN' },
      now,
      recordRef: orderRef('order-1'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'DENIED', reason: 'CUSTOMER_HIDDEN' });
  expect(
    evaluateCustomerRecordVisibility({
      fact: {
        ...visibleFact('order-1'),
        fieldSet: { name: 'order-history.detail.restricted', version: '1' },
        state: 'CUSTOMER_RESTRICTED',
      },
      now,
      recordRef: orderRef('order-1'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'DENIED', reason: 'RESTRICTED_FIELD_SET_REQUIRED' });
  expect(
    evaluateCustomerRecordVisibility({
      fact: 'INDETERMINATE',
      now,
      recordRef: orderRef('order-1'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'UNAVAILABLE', reason: 'VISIBILITY_INDETERMINATE' });
});

it('requires current owner provenance and exposes it with a visibility grant', () => {
  expect(
    evaluateCustomerRecordVisibility({
      fact: { ...visibleFact('order-1'), freshness: 'STALE' },
      now,
      recordRef: orderRef('order-1'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'UNAVAILABLE', reason: 'VISIBILITY_STALE' });
  const visible = evaluateCustomerRecordVisibility({
    fact: visibleFact('order-1'),
    now,
    recordRef: orderRef('order-1'),
    requestedFieldSet: { name: 'customer-history.summary', version: '1' },
    subject: retailSubject,
  });
  expect(visible).toMatchObject({
    outcome: 'VISIBLE',
    ownerModuleId: 'commerce.order',
    policyRevision: 'order-visibility-v1',
    reasonCode: 'ORDER_ACCEPTED_FOR_CUSTOMER',
    sourceRevision: 'visibility-order-1-1',
  });
  expect(
    evaluateCustomerRecordVisibility({
      fact: { ...visibleFact('order-future'), decidedAt: '2026-09-09T10:00:00.001Z' },
      now,
      recordRef: orderRef('order-future'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'UNAVAILABLE', reason: 'VISIBILITY_STALE' });
});

it('requires a complete owner onboarding contract and a closed download decision', () => {
  const decode = Schema.decodeUnknownSync(CustomerRecordTypeOnboardingSchema);
  expect(() =>
    decode({
      canonicalOwnerModuleId: 'commerce.order',
      canonicalResourceType: 'commerce.order.order',
    }),
  ).toThrow();
  expect(
    decode({
      additionalBusinessPolicies: ['commerce.order.customer-visibility.v1'],
      callerPermissions: ['retail.history.read'],
      canonicalOwnerModuleId: 'commerce.order',
      canonicalResourceType: 'commerce.order.order',
      customerContextRelationship: 'RETAIL_OR_COUNTERPARTY',
      defaultVisibilityState: 'CUSTOMER_HIDDEN',
      exportPolicy: { outcome: 'NOT_SUPPORTED' },
      fieldAllowlist: {
        detail: ['accepted-currency'],
        download: [],
        list: ['acceptedAt', 'displayLabel', 'freshness', 'orderRef'],
      },
      fieldContracts: {
        detail: { name: 'customer-order-history.detail', version: '1' },
        download: null,
        list: { name: 'customer-history.summary', version: '1' },
      },
      freshnessPolicy: {
        detail: 'AUTHORITATIVE_CURRENT',
        download: 'AUTHORITATIVE_CURRENT',
        listMaxAgeMilliseconds: 86_400_000,
      },
      migrationAndReconciliationPolicy: 'preserve exact historical customer references',
      partialFailurePolicy: 'OMIT_PROTECTED_CONTENT_AND_REPORT_TYPED_DEGRADATION',
      retentionVisibilityRelationship: 'INDEPENDENT',
      transitionContract: {
        actionKey: 'commerce.order.change-customer-record-visibility',
        eventTopic: 'commerce.order.customer-record-visibility-changed.v1',
        ownerModuleId: 'commerce.order',
      },
    }).exportPolicy,
  ).toEqual({ outcome: 'NOT_SUPPORTED' });
  expect(() =>
    decode({
      additionalBusinessPolicies: ['commerce.order.customer-visibility.v1'],
      callerPermissions: ['retail.history.read'],
      canonicalOwnerModuleId: 'commerce.order',
      canonicalResourceType: 'commerce.order.order',
      customerContextRelationship: 'RETAIL_OR_COUNTERPARTY',
      defaultVisibilityState: 'CUSTOMER_HIDDEN',
      exportPolicy: {
        dataAccessEvidencePolicyKey: 'commerce.order.history-download.v1',
        fieldSet: { name: 'customer-order-history.download', version: '1' },
        outcome: 'GOVERNED_AUTHORITATIVE_CURRENT',
      },
      fieldAllowlist: {
        detail: ['accepted-currency'],
        download: ['accepted-currency'],
        list: ['acceptedAt', 'displayLabel', 'freshness', 'orderRef'],
      },
      fieldContracts: {
        detail: { name: 'customer-order-history.detail', version: '1' },
        download: { name: 'customer-order-history.download', version: '2' },
        list: { name: 'customer-history.summary', version: '1' },
      },
      freshnessPolicy: {
        detail: 'AUTHORITATIVE_CURRENT',
        download: 'AUTHORITATIVE_CURRENT',
        listMaxAgeMilliseconds: 86_400_000,
      },
      migrationAndReconciliationPolicy: 'preserve exact historical customer references',
      partialFailurePolicy: 'OMIT_PROTECTED_CONTENT_AND_REPORT_TYPED_DEGRADATION',
      retentionVisibilityRelationship: 'INDEPENDENT',
      transitionContract: {
        actionKey: 'commerce.claim.change-customer-record-visibility',
        eventTopic: 'commerce.claim.customer-record-visibility-changed.v1',
        ownerModuleId: 'commerce.claim',
      },
    }),
  ).toThrow();
});

it.effect('authoritatively rechecks detail and every returned field', () =>
  Effect.gen(function* retailHistoryDetail() {
    const order = historicalOrder('order-detail', principalId);
    const detailFact = {
      ...visibleFact('order-detail'),
      fieldSet: { name: 'customer-order-history.detail', version: '1' },
    };
    const grant = evaluateCustomerRecordVisibility({
      fact: detailFact,
      now,
      recordRef: order.orderRef,
      requestedFieldSet: detailFact.fieldSet,
      subject: retailSubject,
    });
    if (grant.outcome !== 'VISIBLE') {
      return yield* Effect.die('test visibility grant must be visible');
    }
    let visibilityChecks = 0;
    const resourceChecks: string[] = [];
    const ports: CustomerHistoryPorts = {
      ...makePorts([order]),
      orders: {
        ...makePorts([order]).orders,
        getCustomerFacingDetail: () =>
          Effect.succeed({
            outcome: 'FOUND' as const,
            value: {
              acceptedAt: order.acceptedAt,
              fields: [
                {
                  fieldName: 'accepted-currency',
                  ownerModuleId: 'commerce.order',
                  sourceRevision: grant.sourceRevision,
                  value: { kind: 'REFERENCE' as const, value: orderRef('related-order') },
                  visibility: grant,
                },
                {
                  fieldName: 'unpublished-internal-field',
                  ownerModuleId: 'commerce.order',
                  sourceRevision: grant.sourceRevision,
                  value: { kind: 'TEXT' as const, value: 'must-not-leak' },
                  visibility: grant,
                },
              ],
              freshness: order.freshness,
              orderRef: order.orderRef,
              visibility: grant,
            },
          }),
      },
      resources: {
        current: ({ refs }) => {
          resourceChecks.push(...refs.map((ref) => ref.resourceId));
          return Effect.succeed('CURRENT');
        },
      },
      visibility: {
        get: () => {
          visibilityChecks += 1;
          return Effect.succeed({ fact: detailFact, outcome: 'FOUND' as const });
        },
      },
    };
    const detail = yield* composeRetailOrderHistoryDetail(ports, {
      now,
      orderRef: order.orderRef,
      principalId,
      profileRef: retailProfileRef,
    });
    expect(detail.fields).toHaveLength(1);
    expect(detail.freshness.status).toBe('CURRENT');
    expect(visibilityChecks).toBe(2);
    expect(resourceChecks).toContain('related-order');
    expect(resourceChecks).toContain('visibility-evidence-order-detail');
    return detail;
  }),
);

it.effect('returns only exact-profile visible retail orders', () =>
  Effect.gen(function* retailHistory() {
    const foreignSubject = {
      kind: 'RETAIL_PROFILE' as const,
      profileRef: { ...retailProfileRef, resourceId: 'retail-profile-2' },
    };
    const ports = makePorts([
      historicalOrder('order-visible', principalId),
      historicalOrder('order-foreign', principalId, foreignSubject),
    ]);

    const result = yield* composeRetailOrderHistory(ports, {
      now,
      principalId,
      profileRef: retailProfileRef,
    });

    expect(result.items.map((item) => item.orderRef.resourceId)).toEqual(['order-visible']);
  }),
);

it.effect('enforces onboarding caller permission and rejects future list observations', () =>
  Effect.gen(function* admissionSecurity() {
    const futureOrder = {
      ...historicalOrder('order-future', principalId),
      freshness: {
        observedAt: '2026-09-09T10:00:00.001Z',
        sourceRevision: 'revision-order-future',
        status: 'CURRENT' as const,
      },
    };
    const futureResult = yield* composeRetailOrderHistory(makePorts([futureOrder]), {
      now,
      principalId,
      profileRef: retailProfileRef,
    });
    expect(futureResult.items).toEqual([]);
    expect(futureResult.degradations).toContainEqual({
      code: 'SOURCE_STALE',
      ownerModuleId: 'commerce.order',
      retryable: true,
    });

    const order = historicalOrder('order-caller-denied', principalId);
    const basePorts = makePorts([order]);
    const denied = yield* composeRetailOrderHistory(
      {
        ...basePorts,
        recordTypes: {
          get: (input) =>
            basePorts.recordTypes
              .get(input)
              .pipe(
                Effect.map((contract) =>
                  contract === null
                    ? null
                    : { ...contract, callerPermissions: ['billing.history.read'] },
                ),
              ),
        },
      },
      { now, principalId, profileRef: retailProfileRef },
    );
    expect(denied.items).toEqual([]);
  }),
);

it.effect('enforces every owner-declared policy in the keyed authorization projection', () =>
  Effect.gen(function* keyedPolicySecurity() {
    const order = historicalOrder('order-keyed-policy', principalId);
    const basePorts = makePorts([order]);
    const withPolicies = (
      policies: Readonly<Record<string, 'ALLOWED' | 'DENIED' | 'INDETERMINATE'>>,
    ) =>
      ({
        ...basePorts,
        access: {
          ...basePorts.access,
          retail: (input: {
            readonly principalId: string;
            readonly profileRef: typeof retailProfileRef;
          }) =>
            basePorts.access.retail(input).pipe(Effect.map((facts) => ({ ...facts, policies }))),
        },
      }) satisfies CustomerHistoryPorts;

    const denied = yield* composeRetailOrderHistory(
      withPolicies({ 'commerce.order.customer-visibility.v1': 'DENIED' }),
      { now, principalId, profileRef: retailProfileRef },
    );
    expect(denied.items).toEqual([]);
    expect(denied.degradations).toEqual([]);

    const missing = yield* composeRetailOrderHistory(withPolicies({}), {
      now,
      principalId,
      profileRef: retailProfileRef,
    });
    expect(missing.items).toEqual([]);
    expect(missing.degradations).toContainEqual({
      code: 'VISIBILITY_UNAVAILABLE',
      ownerModuleId: 'commerce.customer-context',
      retryable: true,
    });
  }),
);

it.effect(
  'keeps Retail and Counterparty history access, permission, visibility, and privacy gates independent',
  () =>
    Effect.gen(function* independentHistoryGates() {
      const retailOrder = historicalOrder('order-retail-gates', principalId, retailSubject);
      const counterpartyOrder = historicalOrder(
        'order-counterparty-gates',
        principalId,
        counterpartySubject,
      );
      const retailInput = {
        now,
        principalId,
        profileRef: retailProfileRef,
      };
      const counterpartyInput = {
        counterpartyRef: counterpartySubject.counterpartyRef,
        now,
        principalId,
        profileRef: counterpartyProfileRef,
      };
      const retailPorts = makePorts([retailOrder]);
      const counterpartyBasePorts = makePorts([counterpartyOrder]);
      const counterpartyPorts: CustomerHistoryPorts = {
        ...counterpartyBasePorts,
        access: {
          ...counterpartyBasePorts.access,
          counterparty: (input) =>
            counterpartyBasePorts.access.counterparty(input).pipe(
              Effect.map((facts) => ({
                ...facts,
                historyPermission: 'counterparty.history.read_own',
              })),
            ),
        },
      };

      const retailHistory = yield* composeRetailOrderHistory(retailPorts, retailInput);
      const counterpartyHistory = yield* composeCounterpartyOrderHistory(
        counterpartyPorts,
        counterpartyInput,
      );
      expect(retailHistory.items).toHaveLength(1);
      expect(counterpartyHistory.items).toHaveLength(1);

      const retailAccessDenied = yield* Effect.flip(
        composeRetailOrderHistory(
          {
            ...retailPorts,
            access: {
              ...retailPorts.access,
              retail: (input) =>
                retailPorts.access
                  .retail(input)
                  .pipe(Effect.map((facts) => ({ ...facts, binding: 'ABSENT' as const }))),
            },
          },
          retailInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(retailAccessDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(retailAccessDenied)) {
        expect(retailAccessDenied.reason).toBe('CURRENT_BINDING_REQUIRED');
      }

      const counterpartyAccessDenied = yield* Effect.flip(
        composeCounterpartyOrderHistory(
          {
            ...counterpartyPorts,
            access: {
              ...counterpartyPorts.access,
              counterparty: (input) =>
                counterpartyPorts.access
                  .counterparty(input)
                  .pipe(Effect.map((facts) => ({ ...facts, access: 'ABSENT' as const }))),
            },
          },
          counterpartyInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(counterpartyAccessDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(counterpartyAccessDenied)) {
        expect(counterpartyAccessDenied.reason).toBe('COUNTERPARTY_ACCESS_REQUIRED');
      }

      const retailPermissionDenied = yield* Effect.flip(
        composeRetailOrderHistory(
          {
            ...retailPorts,
            access: {
              ...retailPorts.access,
              retail: (input) =>
                retailPorts.access
                  .retail(input)
                  .pipe(
                    Effect.map((facts) => ({ ...facts, historyPermission: 'ABSENT' as const })),
                  ),
            },
          },
          retailInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(retailPermissionDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(retailPermissionDenied)) {
        expect(retailPermissionDenied.reason).toBe('HISTORY_PERMISSION_REQUIRED');
      }

      const counterpartyPermissionDenied = yield* Effect.flip(
        composeCounterpartyOrderHistory(
          {
            ...counterpartyPorts,
            access: {
              ...counterpartyPorts.access,
              counterparty: (input) =>
                counterpartyPorts.access
                  .counterparty(input)
                  .pipe(Effect.map((facts) => ({ ...facts, historyPermission: null }))),
            },
          },
          counterpartyInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(counterpartyPermissionDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(counterpartyPermissionDenied)) {
        expect(counterpartyPermissionDenied.reason).toBe(
          'COUNTERPARTY_HISTORY_PERMISSION_REQUIRED',
        );
      }

      const retailPolicyDenied = yield* Effect.flip(
        composeRetailOrderHistory(
          {
            ...retailPorts,
            access: {
              ...retailPorts.access,
              retail: (input) =>
                retailPorts.access
                  .retail(input)
                  .pipe(Effect.map((facts) => ({ ...facts, policy: 'DENIED' as const }))),
            },
          },
          retailInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(retailPolicyDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(retailPolicyDenied)) {
        expect(retailPolicyDenied.reason).toBe('OWNER_POLICY_DENIED');
      }

      const counterpartyPolicyDenied = yield* Effect.flip(
        composeCounterpartyOrderHistory(
          {
            ...counterpartyPorts,
            access: {
              ...counterpartyPorts.access,
              counterparty: (input) =>
                counterpartyPorts.access
                  .counterparty(input)
                  .pipe(Effect.map((facts) => ({ ...facts, policy: 'DENIED' as const }))),
            },
          },
          counterpartyInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(counterpartyPolicyDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(counterpartyPolicyDenied)) {
        expect(counterpartyPolicyDenied.reason).toBe('OWNER_POLICY_DENIED');
      }

      const counterpartyAssociationDenied = yield* Effect.flip(
        composeCounterpartyOrderHistory(
          {
            ...counterpartyPorts,
            counterpartyProfiles: { current: () => Effect.succeed('ABSENT' as const) },
          },
          counterpartyInput,
        ),
      );
      expect(Schema.is(HistoryAccessDenied)(counterpartyAssociationDenied)).toBe(true);
      if (Schema.is(HistoryAccessDenied)(counterpartyAssociationDenied)) {
        expect(counterpartyAssociationDenied.reason).toBe('TARGET_CONTEXT_MISMATCH');
      }

      const hiddenRetail = yield* composeRetailOrderHistory(
        {
          ...retailPorts,
          visibility: {
            get: ({ recordRef, subject }) =>
              Effect.succeed({
                fact: { ...visibleFact(recordRef.resourceId, subject), state: 'CUSTOMER_HIDDEN' },
                outcome: 'FOUND' as const,
              }),
          },
        },
        retailInput,
      );
      const hiddenCounterparty = yield* composeCounterpartyOrderHistory(
        {
          ...counterpartyPorts,
          visibility: {
            get: ({ recordRef, subject }) =>
              Effect.succeed({
                fact: { ...visibleFact(recordRef.resourceId, subject), state: 'CUSTOMER_HIDDEN' },
                outcome: 'FOUND' as const,
              }),
          },
        },
        counterpartyInput,
      );
      expect(hiddenRetail.items).toEqual([]);
      expect(hiddenCounterparty.items).toEqual([]);
    }),
);

it.effect('authorizes direct visibility evidence references before returning a grant', () =>
  Effect.gen(function* visibilityEvidenceAuthorization() {
    const order = historicalOrder('order-direct-visibility', principalId);
    const basePorts = makePorts([order]);
    const checkedResourceIds: string[] = [];
    const decision = yield* resolveCustomerRecordVisibility(
      {
        ...basePorts,
        resources: {
          current: ({ refs }) => {
            checkedResourceIds.push(...refs.map((ref) => ref.resourceId));
            return Effect.succeed('CURRENT');
          },
        },
      },
      {
        now,
        principalId,
        purpose: 'HISTORY',
        recordRef: order.orderRef,
        requestedFieldSet: { name: 'customer-history.summary', version: '1' },
        subject: retailSubject,
      },
    );
    expect(decision.outcome).toBe('VISIBLE');
    expect(checkedResourceIds).toEqual([
      'order-direct-visibility',
      'visibility-evidence-order-direct-visibility',
    ]);
  }),
);

it('rejects a visibility evidence reference owned by another module', () => {
  expect(
    evaluateCustomerRecordVisibility({
      fact: {
        ...visibleFact('order-invalid-evidence'),
        evidenceRef: {
          ...visibleFact('order-invalid-evidence').evidenceRef,
          moduleId: 'commerce.billing',
          resourceType: 'commerce.billing.visibility-evidence',
        },
      },
      now,
      recordRef: orderRef('order-invalid-evidence'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: retailSubject,
    }),
  ).toEqual({ outcome: 'UNAVAILABLE', reason: 'VISIBILITY_CONTRACT_INVALID' });
});

it.effect('fails closed when an owner has not published record-type onboarding', () =>
  Effect.gen(function* closedOnboarding() {
    const order = historicalOrder('order-not-onboarded', principalId);
    const ports: CustomerHistoryPorts = {
      ...makePorts([order]),
      recordTypes: { get: () => Effect.succeed(null) },
    };
    const history = yield* composeRetailOrderHistory(ports, {
      now,
      principalId,
      profileRef: retailProfileRef,
    });
    const archive = yield* composeCustomerArchive(ports, {
      now,
      principalId,
      subject: retailSubject,
    });
    expect(history.items).toEqual([]);
    expect(archive.items).toEqual([]);
  }),
);

it.effect('uses immutable actor attribution for own orders and not Buyer role inference', () =>
  Effect.gen(function* ownHistory() {
    const orders = [
      historicalOrder('order-own', principalId, counterpartySubject),
      historicalOrder('order-other', 'principal-2', counterpartySubject),
    ];
    const basePorts = makePorts(orders);
    const ownPorts: CustomerHistoryPorts = {
      ...basePorts,
      access: {
        ...basePorts.access,
        counterparty: () =>
          Effect.succeed({
            access: 'CURRENT',
            archivePermission: 'ABSENT',
            historyPermission: 'counterparty.history.read_own',
            policy: 'ALLOWED',
            purchasePermission: 'CURRENT',
          }),
      },
    };

    const own = yield* composeCounterpartyOrderHistory(ownPorts, {
      counterpartyRef: counterpartySubject.counterpartyRef,
      now,
      principalId,
      profileRef: counterpartyProfileRef,
    });
    expect(own.scope).toBe('OWN_ORDERS');
    expect(own.items.map((item) => item.orderRef.resourceId)).toEqual(['order-own']);

    const deniedPorts: CustomerHistoryPorts = {
      ...ownPorts,
      access: {
        ...ownPorts.access,
        counterparty: () =>
          Effect.succeed({
            access: 'CURRENT',
            archivePermission: 'ABSENT',
            historyPermission: null,
            policy: 'ALLOWED',
            purchasePermission: 'CURRENT',
          }),
      },
    };
    const denied = yield* Effect.exit(
      composeCounterpartyOrderHistory(deniedPorts, {
        counterpartyRef: counterpartySubject.counterpartyRef,
        now,
        principalId,
        profileRef: counterpartyProfileRef,
      }),
    );
    expect(denied._tag).toBe('Failure');
  }),
);

it.effect('isolates the same purchasing profile across distinct Counterparties', () =>
  Effect.gen(function* counterpartyIsolation() {
    const counterpartyBSubject = {
      ...counterpartySubject,
      counterpartyRef: { ...counterpartySubject.counterpartyRef, resourceId: 'counterparty-2' },
    };
    let requestedCounterpartyId = '';
    const basePorts = makePorts([
      historicalOrder('order-a', principalId, counterpartySubject),
      historicalOrder('order-b', principalId, counterpartyBSubject),
    ]);
    const ports: CustomerHistoryPorts = {
      ...basePorts,
      access: {
        ...basePorts.access,
        counterparty: () =>
          Effect.succeed({
            access: 'CURRENT',
            archivePermission: 'CURRENT',
            historyPermission: 'counterparty.history.read_own',
            policy: 'ALLOWED',
            purchasePermission: 'CURRENT',
          }),
      },
      orders: {
        ...basePorts.orders,
        listCounterparty: ({ counterpartyRef }) => {
          requestedCounterpartyId = counterpartyRef.resourceId;
          return Effect.succeed([
            historicalOrder('order-a', principalId, counterpartySubject),
            historicalOrder('order-b', principalId, counterpartyBSubject),
          ]);
        },
      },
    };

    const result = yield* composeCounterpartyOrderHistory(ports, {
      counterpartyRef: counterpartyBSubject.counterpartyRef,
      now,
      principalId,
      profileRef: counterpartyProfileRef,
    });
    expect(requestedCounterpartyId).toBe('counterparty-2');
    expect(result.items.map((item) => item.orderRef.resourceId)).toEqual(['order-b']);
  }),
);

it('denies visibility when only the Counterparty differs', () => {
  const counterpartyBSubject = {
    ...counterpartySubject,
    counterpartyRef: { ...counterpartySubject.counterpartyRef, resourceId: 'counterparty-2' },
  };
  expect(
    evaluateCustomerRecordVisibility({
      fact: visibleFact('order-counterparty-a', counterpartySubject),
      now,
      recordRef: orderRef('order-counterparty-a'),
      requestedFieldSet: { name: 'customer-history.summary', version: '1' },
      subject: counterpartyBSubject,
    }),
  ).toEqual({ outcome: 'DENIED', reason: 'SUBJECT_MISMATCH' });
});

it.effect('requires read-all explicitly before returning other actors orders', () =>
  Effect.gen(function* allHistory() {
    const orders = [
      historicalOrder('order-own', principalId, counterpartySubject),
      historicalOrder('order-other', 'principal-2', counterpartySubject),
    ];
    const ports = makePorts(orders);

    const result = yield* composeCounterpartyAllOrderHistory(ports, {
      counterpartyRef: counterpartySubject.counterpartyRef,
      now,
      principalId,
      profileRef: counterpartyProfileRef,
    });

    expect(result.scope).toBe('ALL_COUNTERPARTY_ORDERS');
    expect(result.items.map((item) => item.orderRef.resourceId)).toEqual([
      'order-own',
      'order-other',
    ]);

    const ownOnlyPorts: CustomerHistoryPorts = {
      ...ports,
      access: {
        ...ports.access,
        counterparty: () =>
          Effect.succeed({
            access: 'CURRENT',
            archivePermission: 'CURRENT',
            historyPermission: 'counterparty.history.read_own',
            policy: 'ALLOWED',
            purchasePermission: 'CURRENT',
          }),
      },
    };
    const denied = yield* Effect.exit(
      composeCounterpartyAllOrderHistory(ownOnlyPorts, {
        counterpartyRef: counterpartySubject.counterpartyRef,
        now,
        principalId,
        profileRef: counterpartyProfileRef,
      }),
    );
    expect(denied._tag).toBe('Failure');
  }),
);

it.effect('keeps archive ownership and reports typed partial degradation', () =>
  Effect.gen(function* customerArchive() {
    const basePorts = makePorts([historicalOrder('order-1', principalId)]);
    const ports: CustomerHistoryPorts = {
      ...basePorts,
      archiveSources: [
        ...basePorts.archiveSources,
        {
          list: () => Effect.fail(new HistoryOwnerUnavailable({ ownerModuleId: 'commerce.claim' })),
          ownerModuleId: 'commerce.claim',
        },
      ],
    };

    const result = yield* composeCustomerArchive(ports, {
      now,
      principalId,
      subject: retailSubject,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.recordRef.moduleId).toBe('commerce.order');
    expect(result.degradations).toEqual([
      { code: 'SOURCE_UNAVAILABLE', ownerModuleId: 'commerce.claim', retryable: true },
    ]);
  }),
);

it.effect('omits archive records beyond the owner-declared freshness limit', () =>
  Effect.gen(function* staleArchive() {
    const stale = {
      ...historicalOrder('order-stale', principalId),
      freshness: {
        observedAt: '2026-09-01T10:00:00.000Z',
        sourceRevision: 'revision-order-stale',
        status: 'STALE' as const,
      },
    };
    const result = yield* composeCustomerArchive(makePorts([stale]), {
      now,
      principalId,
      subject: retailSubject,
    });
    expect(result.items).toEqual([]);
    expect(result.degradations).toContainEqual({
      code: 'SOURCE_STALE',
      ownerModuleId: 'commerce.order',
      retryable: true,
    });
  }),
);

it.effect('does not promote read-all authority through the own-scoped archive endpoint', () =>
  Effect.gen(function* exactArchiveScope() {
    const result = yield* Effect.exit(
      composeCustomerArchive(makePorts([historicalOrder('order-a', principalId)]), {
        now,
        principalId,
        subject: counterpartySubject,
      }),
    );
    expect(result._tag).toBe('Failure');
  }),
);

it.effect('returns Counterparty-wide archive only through the read-all composition', () =>
  Effect.gen(function* allArchive() {
    const result = yield* composeCounterpartyAllCustomerArchive(
      makePorts([
        historicalOrder('order-own', principalId, counterpartySubject),
        historicalOrder('order-other', 'principal-2', counterpartySubject),
      ]),
      {
        counterpartyRef: counterpartySubject.counterpartyRef,
        now,
        principalId,
        profileRef: counterpartyProfileRef,
      },
    );
    expect(result.items.map((item) => item.recordRef.resourceId)).toEqual([
      'order-own',
      'order-other',
    ]);
  }),
);

it.effect('keeps repeat lines independent without creating a Cart or changing quantity', () =>
  Effect.gen(function* repeatPreparation() {
    const baseSource = historicalOrder('order-1', principalId);
    const source: HistoricalOrderCandidate = {
      ...baseSource,
      lines: [
        ...baseSource.lines,
        {
          productRef: 'discontinued-product',
          requestedQuantity: '4',
          sourceLineRef: 'order-1:line-2',
        },
      ],
    };
    const basePorts = makePorts([source]);
    const ports: CustomerHistoryPorts = {
      ...basePorts,
      cart: {
        prepareLine: (_subject, line) =>
          line.productRef === 'discontinued-product'
            ? Effect.succeed({
                reason: 'PRODUCT_NOT_SELLABLE' as const,
                requestedQuantity: line.requestedQuantity,
                sourceLineRef: line.sourceLineRef,
                status: 'SKIPPED' as const,
              })
            : Effect.succeed({
                currentProductRef: line.productRef,
                requestedQuantity: line.requestedQuantity,
                sourceLineRef: line.sourceLineRef,
                status: 'REPEATABLE' as const,
              }),
      },
    };

    const result = yield* prepareRepeatOrder(ports, {
      now,
      orderRef: source.orderRef,
      principalId,
      subject: retailSubject,
    });

    expect(result.outcome).toBe('PREPARED');
    expect(result.lines).toEqual([
      {
        currentProductRef: 'product-1',
        requestedQuantity: '2',
        sourceLineRef: 'order-1:line-1',
        status: 'REPEATABLE',
      },
      {
        reason: 'PRODUCT_NOT_SELLABLE',
        requestedQuantity: '4',
        sourceLineRef: 'order-1:line-2',
        status: 'SKIPPED',
      },
    ]);
    expect('cartRef' in result).toBe(false);
  }),
);

it.effect('rejects a Repeat owner result bound to a different Order ResourceRef', () =>
  Effect.gen(function* misboundRepeatOrder() {
    const source = historicalOrder('order-owner-binding', principalId);
    const basePorts = makePorts([source]);
    const misboundOrder: HistoricalOrderCandidate = {
      ...source,
      orderRef: {
        moduleId: 'commerce.order-shadow',
        resourceId: 'order-owner-binding-other',
        resourceType: 'commerce.order-shadow.order',
        tenantId: '118f8b4e-35a2-7b51-8d56-91a4f37d6a22',
      },
    };
    const failure = yield* prepareRepeatOrder(
      {
        ...basePorts,
        orders: {
          ...basePorts.orders,
          getForRepeat: () => Effect.succeed({ outcome: 'FOUND' as const, value: misboundOrder }),
        },
      },
      {
        now,
        orderRef: source.orderRef,
        principalId,
        subject: retailSubject,
      },
    ).pipe(Effect.flip);

    expect(Schema.is(HistoryRecordNotFound)(failure)).toBe(true);
  }),
);

it.effect('requires canonical product identity before a line is repeatable', () =>
  Effect.gen(function* productIdentity() {
    const source = historicalOrder('order-product-drift', principalId);
    const basePorts = makePorts([source]);
    const result = yield* prepareRepeatOrder(
      {
        ...basePorts,
        cart: {
          prepareLine: (_subject, line) =>
            Effect.succeed({
              currentProductRef: 'different-current-product',
              requestedQuantity: line.requestedQuantity,
              sourceLineRef: line.sourceLineRef,
              status: 'REPEATABLE',
            }),
        },
      },
      {
        now,
        orderRef: source.orderRef,
        principalId,
        subject: retailSubject,
      },
    );
    expect(result).toMatchObject({
      lines: [{ reason: 'CURRENT_SELECTION_REQUIRED', status: 'REQUIRES_EXPLICIT_CHANGE' }],
      outcome: 'NO_REPEATABLE_LINES',
    });
  }),
);

it.effect('allows Counterparty repeat with read-all and scopes read-own to the submitter', () =>
  Effect.gen(function* counterpartyRepeatHistoryScope() {
    const source = historicalOrder('order-repeat-other', 'principal-2', counterpartySubject);
    const allResult = yield* prepareRepeatOrder(makePorts([source]), {
      now,
      orderRef: source.orderRef,
      principalId,
      subject: counterpartySubject,
    });
    expect(allResult.outcome).toBe('PREPARED');

    const basePorts = makePorts([source]);
    const ownFailure = yield* prepareRepeatOrder(
      {
        ...basePorts,
        access: {
          ...basePorts.access,
          counterparty: () =>
            Effect.succeed({
              access: 'CURRENT',
              archivePermission: 'CURRENT',
              historyPermission: 'counterparty.history.read_own',
              policy: 'ALLOWED',
              purchasePermission: 'CURRENT',
            }),
        },
      },
      { now, orderRef: source.orderRef, principalId, subject: counterpartySubject },
    ).pipe(Effect.flip);
    expect(Schema.is(HistoryRecordNotFound)(ownFailure)).toBe(true);
  }),
);

it.effect(
  'rejects unknown Counterparty repeat permissions instead of defaulting to own scope',
  () =>
    Effect.gen(function* malformedRepeatPermission() {
      const source = historicalOrder(
        'order-repeat-unknown-permission',
        'principal-2',
        counterpartySubject,
      );
      const basePorts = makePorts([source]);
      const malformedPorts: CustomerHistoryPorts = {
        ...basePorts,
        access: {
          ...basePorts.access,
          counterparty: () =>
            Effect.succeed({
              access: 'CURRENT' as const,
              archivePermission: 'CURRENT' as const,
              // SAFETY: Deliberately inject a malformed runtime value to verify closed-world authorization.
              historyPermission: JSON.parse('"counterparty.history.read_unknown"'),
              policy: 'ALLOWED' as const,
              purchasePermission: 'CURRENT' as const,
            }),
        },
      };
      const failure = yield* Effect.exit(
        prepareRepeatOrder(malformedPorts, {
          now,
          orderRef: source.orderRef,
          principalId,
          subject: counterpartySubject,
        }),
      );
      expect(failure._tag).toBe('Failure');
    }),
);
