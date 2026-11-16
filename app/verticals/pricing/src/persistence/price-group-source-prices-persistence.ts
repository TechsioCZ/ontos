import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { defineScopedRoutine, ReadHandlerUnavailable, ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { PriceGroupSourcePricesResponseSchema } from '../../shared/apis/price-group-source-prices.ts';
import type { PriceGroupSourcePricesRequest } from '../../shared/apis/price-group-source-prices.ts';

const routine = defineScopedRoutine({
  name: 'read_price_group_source_prices_v1',
  ownerModuleKey: 'commerce.pricing',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ payload: Schema.Unknown }),
  routineKey: 'pricing.read-price-group-source-prices-v1',
  schema: 'pricing',
});
type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Pricing group source facts cannot be read safely',
    }),
    'cause',
    { value: cause },
  );

export const priceGroupSourcePricesPersistenceForScope = (
  transaction: Pick<Transaction, 'invoke'>,
  scope: OperationalScope,
) =>
  Effect.succeed({
    list: Effect.fn('PriceGroupSourcePricesPersistence.list')(function* list(input: PriceGroupSourcePricesRequest) {
      if (input.priceGroupRef.tenantId !== scope.tenantId || scope.legalEntityId === undefined) {
        return yield* new ReadHandlerNotFound({
          code: 'read_handler_not_found',
          reason: 'The requested Pricing source scope does not exist',
        });
      }
      const rows = yield* transaction.invoke(routine, [input]).pipe(Effect.mapError(unavailable));
      if (rows.length !== 1) {
        return yield* unavailable();
      }
      const result = yield* Schema.decodeUnknownEffect(PriceGroupSourcePricesResponseSchema)(rows[0]?.payload).pipe(
        Effect.mapError(unavailable),
      );
      if (result.limit !== input.limit || result.offset !== input.offset || result.prices.length > input.limit) {
        return yield* unavailable();
      }
      for (const row of result.prices) {
        const ref =
          row.price.outcome === 'PRICE_DEFINITION_CURRENT' ? row.price.definition.priceRef : row.price.priceRef;
        if (ref.tenantId !== scope.tenantId) {
          return yield* unavailable();
        }
        if (row.price.outcome === 'PRICE_DEFINITION_CURRENT') {
          const key = row.price.definition.identityKey;
          const source = row.provenance?.evidence.sourceAssertion.sourceRecord.sourceSystem;
          if (
            key.commercialScope.sellingLegalEntityId !== scope.legalEntityId ||
            key.priceGroupSelector.kind !== 'PRICE_GROUP' ||
            key.priceGroupSelector.priceGroupRef.resourceId !== input.priceGroupRef.resourceId ||
            key.priceGroupSelector.priceGroupRef.tenantId !== scope.tenantId ||
            source?.ownerModuleId !== input.sourceSystem.ownerModuleId ||
            source.sourceSystemRef !== input.sourceSystem.sourceSystemRef
          ) {
            return yield* unavailable();
          }
        }
      }
      return result;
    }),
  });
