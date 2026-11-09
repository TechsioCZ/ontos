import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  PriceGroupSourceCorrelationSchema,
  PriceGroupSourceAssociationsRequestSchema,
} from '../../shared/apis/price-group-source-associations.ts';
import { PriceGroupResultLookupResponseSchema } from '../../shared/apis/price-group-result-lookup.ts';
import { priceGroupSourcePersistenceForScope } from '../../src/persistence/price-group-source-persistence.ts';

const tenantId = 'a1400000-0000-4000-8000-000000000001';
const actionInvocationId = 'a1400000-0000-4000-8000-000000000002';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'internal-c14-source-test',
  principalId: 'a1400000-0000-4000-8000-000000000003',
  tenantId,
};
const sourceCorrelation = {
  issuer: 'internal-issuer',
  mappingVersion: '1',
  namespace: 'group-priced-list',
  recordKey: 'opaque/id',
  routeId: 'internal-route',
};
const request = {
  issuer: sourceCorrelation.issuer,
  limit: 1,
  namespace: sourceCorrelation.namespace,
  offset: 0,
  routeId: sourceCorrelation.routeId,
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: 'a1400000-0000-4000-8000-000000000004',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};

describe('C14 internal owner source correlation boundary', () => {
  it('requires exact qualifiers and explicit bounded pagination', () => {
    expect(Schema.is(PriceGroupSourceCorrelationSchema)(sourceCorrelation)).toBe(true);
    expect(
      Schema.is(PriceGroupSourceCorrelationSchema)({
        ...sourceCorrelation,
        sourceOccurrenceId: 'internal-source-occurrence',
      }),
    ).toBe(true);
    expect(Schema.is(PriceGroupSourceCorrelationSchema)({ ...sourceCorrelation, sourceOccurrenceId: '' })).toBe(false);
    expect(
      Schema.is(PriceGroupSourceCorrelationSchema)({ ...sourceCorrelation, sourceOccurrenceId: ' occurrence ' }),
    ).toBe(false);
    expect(Schema.is(PriceGroupSourceCorrelationSchema)({ ...sourceCorrelation, issuer: '' })).toBe(false);
    expect(Schema.is(PriceGroupSourceCorrelationSchema)({ ...sourceCorrelation, recordKey: ' id ' })).toBe(false);
    expect(Schema.is(PriceGroupSourceAssociationsRequestSchema)(request)).toBe(true);
    expect(Schema.is(PriceGroupSourceAssociationsRequestSchema)({ ...request, limit: 0 })).toBe(false);
    expect(Schema.is(PriceGroupSourceAssociationsRequestSchema)({ ...request, limit: 101 })).toBe(false);
    expect(Schema.is(PriceGroupSourceAssociationsRequestSchema)({ ...request, offset: -1 })).toBe(false);
  });

  it.effect('fails closed on another issuer, tenant, page identity, or ambiguous owner response', () =>
    Effect.gen(function* sourceResultBinding() {
      const page = { associations: [{ priceGroupRef, sourceCorrelation }], count: 1, limit: 1, offset: 0 };
      const invalidPages = [
        {
          ...page,
          associations: [{ priceGroupRef, sourceCorrelation: { ...sourceCorrelation, issuer: 'other-issuer' } }],
        },
        {
          ...page,
          associations: [
            {
              priceGroupRef: { ...priceGroupRef, tenantId: 'a1400000-0000-4000-8000-000000000099' },
              sourceCorrelation,
            },
          ],
        },
        { ...page, offset: 1 },
      ];
      for (const invalidPage of invalidPages) {
        const services = yield* priceGroupSourcePersistenceForScope(
          { invoke: () => Effect.succeed([{ payload: invalidPage }]) },
          scope,
        );
        const failure = yield* services.list(request).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      }
      const ambiguous = yield* priceGroupSourcePersistenceForScope(
        { invoke: () => Effect.succeed([{ payload: page }, { payload: page }]) },
        scope,
      );
      expect(yield* ambiguous.list(request).pipe(Effect.flip)).toBeInstanceOf(ReadHandlerUnavailable);
      const valid = yield* priceGroupSourcePersistenceForScope(
        { invoke: () => Effect.succeed([{ payload: page }]) },
        scope,
      );
      expect(yield* valid.list(request)).toEqual(page);
    }),
  );

  it.effect('never turns malformed, unavailable, or mismatched recovery evidence into absence', () =>
    Effect.gen(function* operationReceiptBinding() {
      const receipt = {
        actionInvocationId,
        catalogRevision: 1,
        definitionRevisionId: 'a1400000-0000-4000-8000-000000000005',
        operationKind: 'CREATE_PRICE_GROUP' as const,
        priceGroupRef,
      };
      const found = { outcome: 'PRICE_GROUP_OPERATION_FOUND' as const, receipt };
      expect(Schema.is(PriceGroupResultLookupResponseSchema)(found)).toBe(true);
      const mismatched = yield* priceGroupSourcePersistenceForScope(
        {
          invoke: () =>
            Effect.succeed([
              {
                payload: {
                  ...found,
                  receipt: { ...receipt, actionInvocationId: 'a1400000-0000-4000-8000-000000000099' },
                },
              },
            ]),
        },
        scope,
      );
      expect(yield* mismatched.recover({ actionInvocationId }).pipe(Effect.flip)).toBeInstanceOf(
        ReadHandlerUnavailable,
      );
      const unavailable = yield* priceGroupSourcePersistenceForScope({ invoke: () => Effect.succeed([]) }, scope);
      expect(yield* unavailable.recover({ actionInvocationId }).pipe(Effect.flip)).toBeInstanceOf(
        ReadHandlerUnavailable,
      );
    }),
  );
});
