import { ActionPermissionCheckError, ActionPermissionDenied } from '@app/core-runtime';
import {
  PricingContractualDiscountRevisionSchema,
  PricingContractualDiscountScheduleAcknowledgementSchema,
  PricingContractualDiscountScheduleSnapshotSchema,
} from '@app/pricing-contracts';
import { PricingDiscountIdentityKeySchema } from '@app/pricing-contracts/domain/discount';
import { DateTime, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { mapManageContractualDiscountActionProblem } from '../../api/manage-contractual-discount-action-problems.ts';
import {
  ManageContractualDiscountAcknowledgementRequired,
  ManageContractualDiscountConflict,
  ManageContractualDiscountPayloadSchema,
  ManageContractualDiscountRejected,
  applyContractualDiscountManagement,
  manageContractualDiscountAction,
} from '../../src/actions/manage-contractual-discount.action.ts';
import type { ManageContractualDiscountActionServices } from '../../src/actions/manage-contractual-discount.action.ts';
import { executeManageContractualDiscountWithAuthorization } from '../../src/api/manage-contractual-discount-action-client.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '11111111-1111-4111-8111-111111111112';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const operationAt = '2026-09-28T10:00:00.000Z';
const currentPeriod = {
  effectiveFrom: '2026-09-28T09:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
};
const futurePeriod = {
  effectiveFrom: '2026-10-02T00:00:00.000Z',
  effectiveTo: null,
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const commercialScope = {
  channelId: 'B2B',
  marketId: 'cz-launch',
  sellingLegalEntityId: legalEntityId,
};
const lineBasis = {
  catalogSelection: { productRef, variantRef },
  kind: 'VARIANT_LINE' as const,
  unitBasis: { quantity: '1', unitRef },
};
const linePercentageIdentity = Schema.decodeUnknownSync(PricingDiscountIdentityKeySchema)({
  audience: { kind: 'PRICE_GROUP', priceGroupRef },
  basis: lineBasis,
  commercialScope,
  currencyCode: 'CZK',
  effectKind: 'PERCENTAGE',
  family: 'CONTRACTUAL_DISCOUNT',
  monetaryBoundary: 'PRE_TAX',
  scope: 'VARIANT_LINE',
});
const discountId = '99999999-9999-4999-8999-999999999999';
const currentRevision = Schema.decodeSync(PricingContractualDiscountRevisionSchema)({
  definition: {
    discountId,
    identityKey: linePercentageIdentity,
    revision: {
      configuredEffect: { kind: 'PERCENTAGE', level: '10' },
      effectiveFrom: currentPeriod.effectiveFrom,
      revision: 1,
      revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  },
  effectivePeriod: currentPeriod,
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});
const futureRevision = Schema.decodeSync(PricingContractualDiscountRevisionSchema)({
  definition: {
    discountId,
    identityKey: linePercentageIdentity,
    revision: {
      configuredEffect: { kind: 'PERCENTAGE', level: '15' },
      effectiveFrom: futurePeriod.effectiveFrom,
      revision: 2,
      revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
  },
  effectivePeriod: futurePeriod,
  lineage: {
    correctedRevisionId: null,
    kind: 'SCHEDULED',
    previousRevisionId: currentRevision.definition.revision.revisionId,
  },
});
const schedule = Schema.decodeSync(PricingContractualDiscountScheduleSnapshotSchema)({
  current: currentRevision,
  discountId,
  future: [futureRevision],
  identityKey: linePercentageIdentity,
  observedAt: operationAt,
  revisions: [currentRevision, futureRevision],
  scheduleRevision: 2,
});
const expectedCurrent = {
  discountId,
  effectivePeriod: currentPeriod,
  identityKey: linePercentageIdentity,
  revision: currentRevision.definition.revision.revision,
  revisionId: currentRevision.definition.revision.revisionId,
  scheduleRevision: schedule.scheduleRevision,
};
const acknowledgement = Schema.decodeSync(PricingContractualDiscountScheduleAcknowledgementSchema)({
  actingPrincipalId: principalId,
  discountId,
  fingerprint: 'c'.repeat(64),
  identityKey: linePercentageIdentity,
  intendedConfiguredEffect: { kind: 'PERCENTAGE', level: '12' },
  intendedEffectivePeriod: { effectiveFrom: operationAt, effectiveTo: currentPeriod.effectiveTo },
  intent: 'VALUE_ONLY_CURRENT',
  presentedFuture: [futureRevision],
  scheduleRevision: schedule.scheduleRevision,
  targetEffectivePeriod: currentPeriod,
  targetRevisionId: currentRevision.definition.revision.revisionId,
});
const trusted = {
  actingPrincipalId: principalId,
  actionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  legalEntityId,
  requestCorrelationId: 'contractual-discount-797',
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationAt)),
};
const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const currentCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: operationAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: operationAt,
    revalidatedAt: operationAt,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  generation: 1,
  observedAt: operationAt,
  pricingRevision: 'pricing-currency-support:1',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
  supportRootRef,
};

const decodePayload = Schema.decodeUnknownSync(ManageContractualDiscountPayloadSchema, {
  onExcessProperty: 'error',
});
const createPayload = decodePayload({
  configuredEffect: { kind: 'PERCENTAGE', level: '10' },
  effectivePeriod: currentPeriod,
  expectedState: { state: 'ABSENT' },
  identityKey: linePercentageIdentity,
  intent: 'CREATE',
  reason: 'Create the exact contractual Discount',
});
const valuePayload = decodePayload({
  acknowledgement,
  configuredEffect: { kind: 'PERCENTAGE', level: '12' },
  expectedCurrent,
  identityKey: linePercentageIdentity,
  intent: 'VALUE_ONLY_CURRENT',
  reason: 'Change only Current value after reviewing the future schedule',
});
const unacknowledgedValuePayload = decodePayload({
  configuredEffect: { kind: 'PERCENTAGE', level: '12' },
  expectedCurrent,
  identityKey: linePercentageIdentity,
  intent: 'VALUE_ONLY_CURRENT',
  reason: 'Request the exact future schedule before changing Current',
});
const scheduleRevisionPayload = decodePayload({
  configuredEffect: { kind: 'PERCENTAGE', level: '15' },
  effectivePeriod: futurePeriod,
  expectedScheduleRevision: schedule.scheduleRevision,
  identityKey: linePercentageIdentity,
  intent: 'SCHEDULE_REVISION',
  reason: 'Schedule the exact future contractual Discount revision',
});

const services = (
  manage: ManageContractualDiscountActionServices['manage'],
): ManageContractualDiscountActionServices => ({
  loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
  manage,
});

describe('Contractual Discount management Action issue #797', () => {
  it('publishes the generated scoped Action and the exact supported contractual matrix', () => {
    expect(manageContractualDiscountAction.descriptor).toMatchObject({
      actionKey: 'commerce.pricing.manage-contractual-discount',
      idempotency: 'required',
      legalEntityScope: 'required',
      payloadSchema: ManageContractualDiscountPayloadSchema,
    });

    const identities = [
      linePercentageIdentity,
      {
        ...linePercentageIdentity,
        effectKind: 'FIXED_MONETARY_AMOUNT',
      },
      {
        ...linePercentageIdentity,
        audience: { counterpartyRef, kind: 'COUNTERPARTY' },
      },
      {
        ...linePercentageIdentity,
        audience: { counterpartyRef, kind: 'COUNTERPARTY' },
        effectKind: 'FIXED_MONETARY_AMOUNT',
      },
      {
        ...linePercentageIdentity,
        audience: { counterpartyRef, kind: 'COUNTERPARTY' },
        basis: { kind: 'WHOLE_PURCHASE' },
        effectKind: 'FIXED_MONETARY_AMOUNT',
        scope: 'WHOLE_PURCHASE',
      },
    ];
    expect(identities.every(Schema.is(PricingDiscountIdentityKeySchema))).toBe(true);
    expect(
      Schema.is(PricingDiscountIdentityKeySchema)({
        ...linePercentageIdentity,
        audience: { kind: 'CATALOG_PATH', selection: lineBasis.catalogSelection },
      }),
    ).toBe(false);
    expect(() => decodePayload({ ...createPayload, storefrontId: 'storefront-cz' })).toThrow();
    if (createPayload.intent !== 'CREATE') {
      throw new Error('Expected the CREATE contractual Discount fixture');
    }
    const { expectedState: _expectedState, ...createWithoutExpectedState } = createPayload;
    expect(() => decodePayload(createWithoutExpectedState)).toThrow();
  });

  it.effect('creates atomically through persistence and preserves exact logical identity and interval', () =>
    Effect.gen(function* createExactDiscount() {
      let observedCommand: unknown;
      const result = yield* applyContractualDiscountManagement(
        createPayload,
        trusted,
        services((command) => {
          observedCommand = command;
          return Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_CREATED' as const, schedule });
        }),
      );

      expect(observedCommand).toMatchObject({
        effectivePeriod: currentPeriod,
        expectedState: { state: 'ABSENT' },
        identityKey: linePercentageIdentity,
        intent: 'CREATE',
      });
      expect(result).toMatchObject({ outcome: 'CONTRACTUAL_DISCOUNT_CREATED', schedule });
    }),
  );

  it.effect('rejects untrusted scope and EUR activation before persistence or support lookup', () =>
    Effect.gen(function* rejectOutOfScopeAndEuro() {
      let supportReads = 0;
      let writes = 0;
      const rejectingServices: ManageContractualDiscountActionServices = {
        loadCurrencySupport: () => {
          supportReads += 1;
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
        manage: () => {
          writes += 1;
          return Effect.die('Rejected commands must not reach persistence');
        },
      };
      const scopeFailure = yield* applyContractualDiscountManagement(
        createPayload,
        { ...trusted, tenantId: otherTenantId },
        rejectingServices,
      ).pipe(Effect.flip);
      const euroPayload = decodePayload({
        configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT', level: { amount: '20', currencyCode: 'EUR' } },
        effectivePeriod: currentPeriod,
        expectedState: { state: 'ABSENT' },
        identityKey: {
          ...linePercentageIdentity,
          audience: { counterpartyRef, kind: 'COUNTERPARTY' },
          currencyCode: 'EUR',
          effectKind: 'FIXED_MONETARY_AMOUNT',
        },
        intent: 'CREATE',
        reason: 'General schema remains multi-currency but Launch does not activate EUR',
      });
      const currencyFailure = yield* applyContractualDiscountManagement(euroPayload, trusted, rejectingServices).pipe(
        Effect.flip,
      );

      expect(scopeFailure).toBeInstanceOf(ManageContractualDiscountRejected);
      expect(scopeFailure).toMatchObject({ code: 'manage_contractual_discount_scope_mismatch' });
      expect(currencyFailure).toBeInstanceOf(ManageContractualDiscountRejected);
      expect(currencyFailure).toMatchObject({ code: 'manage_contractual_discount_currency_not_enabled' });
      expect({ supportReads, writes }).toEqual({ supportReads: 0, writes: 0 });
    }),
  );

  it.effect('requires exact future-schedule acknowledgement before value-only Current change', () =>
    Effect.gen(function* acknowledgeFutureSchedule() {
      const challenge = yield* applyContractualDiscountManagement(
        unacknowledgedValuePayload,
        trusted,
        services(() =>
          Effect.succeed({
            acknowledgement,
            outcome: 'CONTRACTUAL_DISCOUNT_ACKNOWLEDGEMENT_REQUIRED' as const,
          }),
        ),
      ).pipe(Effect.flip);
      expect(challenge).toBeInstanceOf(ManageContractualDiscountAcknowledgementRequired);
      expect(challenge).toMatchObject({ acknowledgement });
      expect(mapManageContractualDiscountActionProblem(challenge)).toMatchObject({
        acknowledgement,
        code: 'contractual_discount_schedule_acknowledgement_required',
        status: 422,
      });

      let observedCommand: unknown;
      yield* applyContractualDiscountManagement(
        valuePayload,
        trusted,
        services((command) => {
          observedCommand = command;
          return Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED' as const, schedule });
        }),
      );
      expect(observedCommand).toMatchObject({
        acknowledgement,
        expectedCurrent,
        intent: 'VALUE_ONLY_CURRENT',
      });
      expect(acknowledgement.intendedEffectivePeriod).toEqual({
        effectiveFrom: operationAt,
        effectiveTo: currentPeriod.effectiveTo,
      });
      expect(acknowledgement.presentedFuture).toEqual([futureRevision]);
    }),
  );

  it.effect('checks Currency Support at the trusted operation instant for a Current value change', () =>
    Effect.gen(function* checkCurrentCurrencyAtOperationTime() {
      let evaluatedAt: string | undefined;
      const result = yield* applyContractualDiscountManagement(valuePayload, trusted, {
        loadCurrencySupport: ({ effectiveAt }) => {
          evaluatedAt = effectiveAt;
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
        manage: () => Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED' as const, schedule }),
      });
      expect(result.outcome).toBe('CONTRACTUAL_DISCOUNT_REVISED');
      expect(evaluatedAt).toBe(operationAt);
    }),
  );

  it.effect('retries an acknowledged Current value change against the acknowledged successor boundary', () =>
    Effect.gen(function* preserveAcknowledgedBoundary() {
      const retryAt = DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-28T10:35:00.000Z'));
      const boundaryAcknowledgement = {
        ...acknowledgement,
        intendedEffectivePeriod: {
          ...acknowledgement.intendedEffectivePeriod,
          effectiveFrom: '2026-09-28T10:30:00.000Z',
        },
      };
      const retryPayload = decodePayload({ ...valuePayload, acknowledgement: boundaryAcknowledgement });
      let evaluatedAt: string | undefined;

      yield* applyContractualDiscountManagement(
        retryPayload,
        { ...trusted, trustedOperationAt: retryAt },
        {
          loadCurrencySupport: ({ effectiveAt }) => {
            evaluatedAt = effectiveAt;
            return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
          },
          manage: () => Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED' as const, schedule }),
        },
      );

      expect(evaluatedAt).toBe('2026-09-28T10:30:00.000Z');
    }),
  );

  it.effect('schedules an exact future revision with schedule concurrency evidence', () =>
    Effect.gen(function* scheduleExactFutureRevision() {
      let evaluatedAt: string | undefined;
      let observedCommand: unknown;
      const result = yield* applyContractualDiscountManagement(scheduleRevisionPayload, trusted, {
        loadCurrencySupport: ({ effectiveAt }) => {
          evaluatedAt = effectiveAt;
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
        manage: (command) => {
          observedCommand = command;
          return Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED' as const, schedule });
        },
      });

      expect(evaluatedAt).toBe(futurePeriod.effectiveFrom);
      expect(observedCommand).toMatchObject({
        configuredEffect: { kind: 'PERCENTAGE', level: '15' },
        effectivePeriod: futurePeriod,
        expectedScheduleRevision: schedule.scheduleRevision,
        identityKey: linePercentageIdentity,
        intent: 'SCHEDULE_REVISION',
      });
      expect(result).toMatchObject({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED', schedule });
    }),
  );

  it.effect('dispatches SCHEDULE_REVISION through the generated Action client', () =>
    Effect.gen(function* dispatchScheduledRevision() {
      const requests: Request[] = [];
      const fakeFetch: typeof globalThis.fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED', schedule }, { status: 200 }));
      };
      const result = yield* executeManageContractualDiscountWithAuthorization(
        scheduleRevisionPayload,
        'Bearer owner-assertion',
        'contractual-discount-schedule-797',
        {
          baseUrl: 'https://pricing.example/pricing-api',
          idempotencyKey: 'contractual-discount-schedule-797',
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      const [request] = requests;
      if (request === undefined) {
        throw new Error('The contractual Discount Action client did not issue its request');
      }

      expect(result).toEqual({ outcome: 'CONTRACTUAL_DISCOUNT_REVISED', schedule });
      expect(request.url).toBe('https://pricing.example/pricing-api/pricing/actions/manage-contractual-discount');
      expect(request.headers.get('idempotency-key')).toBe('contractual-discount-schedule-797');
      expect(yield* Effect.promise(() => request.clone().json())).toMatchObject({
        expectedScheduleRevision: schedule.scheduleRevision,
        intent: 'SCHEDULE_REVISION',
      });
    }),
  );

  it('keeps a definite authorization denial distinct from an indeterminate permission check', () => {
    expect(
      mapManageContractualDiscountActionProblem(
        new ActionPermissionDenied({
          code: 'action_permission_denied',
          reason: 'The Principal is not authorized to manage contractual Discounts',
        }),
      ),
    ).toMatchObject({ code: 'action_permission_denied', status: 403 });
    expect(
      mapManageContractualDiscountActionProblem(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'Authorization could not be determined safely',
        }),
      ),
    ).toMatchObject({ code: 'action_permission_check_failed', retryable: true, status: 503 });
  });

  it.effect('passes correction and retirement concurrency evidence and maps typed conflicts', () =>
    Effect.gen(function* manageLifecycle() {
      const observed: unknown[] = [];
      const lifecycleServices = services((command) => {
        observed.push(command);
        return command.intent === 'CORRECT_REVISION'
          ? Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_CORRECTED' as const, schedule })
          : Effect.succeed({ outcome: 'CONTRACTUAL_DISCOUNT_RETIRED' as const, schedule });
      });
      yield* applyContractualDiscountManagement(
        decodePayload({
          configuredEffect: { kind: 'PERCENTAGE', level: '11' },
          expectedScheduleRevision: schedule.scheduleRevision,
          identityKey: linePercentageIdentity,
          intent: 'CORRECT_REVISION',
          reason: 'Correct one immutable historical Revision',
          targetEffectivePeriod: currentPeriod,
          targetRevisionId: currentRevision.definition.revision.revisionId,
        }),
        trusted,
        lifecycleServices,
      );
      yield* applyContractualDiscountManagement(
        decodePayload({
          expectedCurrent,
          identityKey: linePercentageIdentity,
          intent: 'RETIRE_CURRENT',
          reason: 'End only the exact Current interval',
        }),
        trusted,
        lifecycleServices,
      );
      expect(observed).toMatchObject([
        {
          expectedScheduleRevision: schedule.scheduleRevision,
          intent: 'CORRECT_REVISION',
          targetEffectivePeriod: currentPeriod,
          targetRevisionId: currentRevision.definition.revision.revisionId,
        },
        { expectedCurrent, intent: 'RETIRE_CURRENT' },
      ]);

      const conflict = yield* applyContractualDiscountManagement(
        createPayload,
        trusted,
        services(() =>
          Effect.succeed({
            identityKey: linePercentageIdentity,
            outcome: 'CONTRACTUAL_DISCOUNT_CONFLICT' as const,
            reason: 'OVERLAPPING_SCHEDULE' as const,
          }),
        ),
      ).pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(ManageContractualDiscountConflict);
      expect(mapManageContractualDiscountActionProblem(conflict)).toMatchObject({
        code: 'manage_contractual_discount_conflict',
        status: 409,
      });
    }),
  );
});
