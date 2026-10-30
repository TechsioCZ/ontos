import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { HttpApi } from 'effect/http-api';
import { pricingApi } from '../../shared/api.ts';
import { RevisePricePayloadSchema } from '../../shared/actions/revise-price.ts';
import { CurrencySupportScheduleAcknowledgementSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PriceScheduleAcknowledgementSchema,
  PriceScheduleReadResultSchema,
} from '@app/pricing-contracts/domain/price-schedule';
import { DateTime, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  mapRevisePriceActionProblem,
  revisePriceActionSchemaErrorLive,
} from '../../api/revise-price-action-problems.ts';
import { mapSetSupportedCurrenciesActionProblem } from '../../api/set-supported-currencies-action-problems.ts';
import { RevisePriceAcknowledgementRequired } from '../../src/actions/revise-price.action.ts';
import { SupportedCurrenciesScheduleAcknowledgementRequired } from '../../src/actions/set-supported-currencies.action.ts';
import { readPriceSchedule } from '../../src/api/price-schedule.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const currentPeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2026-10-01T00:00:00.000Z',
};
const futurePeriod = {
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: null,
};
const identityKey = (sellingLegalEntityId = legalEntityId) => ({
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2B' as const, marketId: 'CZ', sellingLegalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '77777777-7777-4777-8777-777777777777',
      resourceType: 'commerce.catalog.product-unit' as const,
      tenantId,
    },
  },
});
const scheduledRevision = (
  revisionId: string,
  revision: number,
  effectivePeriod: typeof currentPeriod | typeof futurePeriod,
  sellingLegalEntityId = legalEntityId,
) => ({
  definition: {
    identityKey: identityKey(sellingLegalEntityId),
    priceRef,
    revision: {
      effectiveFrom: effectivePeriod.effectiveFrom,
      monetaryAmount: { amount: revision === 1 ? '100' : '125', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX' as const,
      revision,
      revisionId,
    },
  },
  effectivePeriod,
  lineage:
    revision === 1
      ? { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null }
      : {
          correctedRevisionId: null,
          kind: 'SCHEDULED' as const,
          previousRevisionId: '88888888-8888-4888-8888-888888888888',
        },
});

const currentRevision = scheduledRevision('88888888-8888-4888-8888-888888888888', 1, currentPeriod);
const futureRevision = scheduledRevision('99999999-9999-4999-8999-999999999999', 2, futurePeriod);
const observedAt = '2026-09-27T12:00:00.000Z';
const priceSchedule = Schema.decodeSync(PriceScheduleReadResultSchema)({
  outcome: 'PRICE_SCHEDULE_CURRENT',
  schedule: {
    current: currentRevision,
    future: [futureRevision],
    observedAt,
    priceRef,
    revisions: [currentRevision, futureRevision],
    scheduleRevision: 2,
  },
});
const priceAcknowledgement = Schema.decodeSync(PriceScheduleAcknowledgementSchema)({
  actingPrincipalId: principalId,
  fingerprint: 'a'.repeat(64),
  intendedEffectivePeriod: {
    effectiveFrom: observedAt,
    effectiveTo: currentPeriod.effectiveTo,
  },
  intendedMonetaryAmount: { amount: '110', currencyCode: 'CZK' },
  intent: 'VALUE_ONLY_CURRENT',
  presentedFuture: [futureRevision],
  priceRef,
  scheduleRevision: 2,
  targetRevisionId: currentRevision.definition.revision.revisionId,
});

const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = (resourceId: string) => ({
  moduleId: 'commerce.pricing' as const,
  resourceId,
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
});
const currentSupport = {
  effectivePeriod: currentPeriod,
  generation: 1,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: supportRevisionRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
};
const futureSupport = {
  effectivePeriod: futurePeriod,
  generation: 2,
  supportedCurrencies: ['CZK'],
  supportRevisionRef: supportRevisionRef('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
};
const supportAcknowledgement = Schema.decodeSync(CurrencySupportScheduleAcknowledgementSchema)({
  actingPrincipalId: principalId,
  expectedScheduleRevision: 2,
  fingerprint: 'b'.repeat(64),
  intendedEffectivePeriod: currentPeriod,
  intendedSupportedCurrencies: ['CZK'],
  presentedFuture: [futureSupport],
  supportRootRef,
  targetEffectivePeriod: currentPeriod,
  targetRevisionRef: currentSupport.supportRevisionRef,
});

describe('Pricing management HTTP contract', () => {
  it.live('accepts ordinary transport headers while rejecting excess business payload (#1278)', () =>
    Effect.gen(function* strictPayloadAndTransportHeaders() {
      const api = HttpApi.make('PricingHeaderContract')
        .add(pricingApi.groups.revisePriceAction)
        .annotateMerge(pricingApi.annotations);
      let calls = 0;
      const runtime = assembleEffectBffRuntime({
        api,
        handlers: HttpApiBuilder.group(api, 'revisePriceAction', (handlers) =>
          handlers.handle('execute', () =>
            Effect.sync(() => {
              calls += 1;
              return { outcome: 'PRICE_REVISION_CREATED' as const, revision: futureRevision };
            }),
          ),
        ).pipe(Layer.provide(revisePriceActionSchemaErrorLive)),
      });
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => runtime.createHandler()),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const payload = yield* Schema.decodeUnknownEffect(RevisePricePayloadSchema)({
        expectedCurrent: {
          effectivePeriod: currentPeriod,
          priceRef,
          revision: currentRevision.definition.revision.revision,
          revisionId: currentRevision.definition.revision.revisionId,
          scheduleRevision: 2,
        },
        intent: 'RETIRE_CURRENT',
        priceRef,
        reason: 'Explicit transport-only unit fixture',
      });
      const encoded = yield* Schema.encodeEffect(RevisePricePayloadSchema)(payload);
      const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
      const validBody = yield* encodeRequest(encoded);
      const extraBody = yield* encodeRequest({ ...encoded, undeclaredBusinessField: true });
      for (const [body, idempotencyKey, expectedStatus] of [
        [validBody, 'transport-unit-only', 200],
        [validBody, '', 400],
        [extraBody, 'transport-unit-only', 400],
      ] as const) {
        const response = yield* Effect.promise(() =>
          server.handler(
            new Request('https://pricing.ontos.test/pricing/actions/revise-price', {
              body,
              headers: {
                accept: 'application/json',
                authorization: 'Bearer transport-unit-only',
                'content-type': 'application/json',
                'idempotency-key': idempotencyKey,
                'x-correlation-id': 'transport-unit-only',
              },
              method: 'POST',
            }),
          ),
        );
        expect(response.status).toBe(expectedStatus);
      }
      expect(calls).toBe(1);
    }),
  );

  it('preserves exact Price and Currency Support schedule acknowledgement challenges', () => {
    const priceProblem = mapRevisePriceActionProblem(
      new RevisePriceAcknowledgementRequired({
        acknowledgement: priceAcknowledgement,
        code: 'price_schedule_acknowledgement_required',
        reason: 'Review the future Price schedule',
      }),
    );
    const supportProblem = mapSetSupportedCurrenciesActionProblem(
      new SupportedCurrenciesScheduleAcknowledgementRequired({
        acknowledgement: supportAcknowledgement,
        code: 'supported_currencies_schedule_acknowledgement_required',
        reason: 'Review the future Currency Support schedule',
      }),
    );

    expect(priceProblem).toMatchObject({ acknowledgement: priceAcknowledgement, status: 422 });
    expect(supportProblem).toMatchObject({ acknowledgement: supportAcknowledgement, status: 422 });
  });

  it.effect('returns the exact owner schedule needed to form revision expected state', () =>
    Effect.gen(function* readExactSchedule() {
      const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(observedAt));
      const observed: unknown[] = [];
      const result = yield* readPriceSchedule(
        { priceRef },
        { legalEntityId, tenantId, trustedOperationAt },
        (requestedRef, requestedAt) => {
          observed.push({ requestedAt, requestedRef });
          return Effect.succeed(priceSchedule);
        },
      );

      expect(result).toEqual(priceSchedule);
      expect(observed).toEqual([{ requestedAt: trustedOperationAt, requestedRef: priceRef }]);
    }),
  );

  it.effect('fails cross-scope Price schedule evidence closed without disclosing it', () =>
    Effect.gen(function* rejectCrossScopeSchedule() {
      const trustedOperationAt = DateTime.toDateUtc(DateTime.makeUnsafe(observedAt));
      const wrongScopeCurrent = scheduledRevision(
        currentRevision.definition.revision.revisionId,
        1,
        currentPeriod,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      );
      const wrongScope = yield* Schema.decodeEffect(PriceScheduleReadResultSchema)({
        outcome: 'PRICE_SCHEDULE_CURRENT',
        schedule: {
          current: wrongScopeCurrent,
          future: [],
          observedAt,
          priceRef,
          revisions: [wrongScopeCurrent],
          scheduleRevision: 1,
        },
      });
      const result = yield* readPriceSchedule({ priceRef }, { legalEntityId, tenantId, trustedOperationAt }, () =>
        Effect.succeed(wrongScope),
      );

      expect(result).toMatchObject({ outcome: 'PRICE_SCHEDULE_UNAVAILABLE', priceRef, retryable: true });
    }),
  );
});
