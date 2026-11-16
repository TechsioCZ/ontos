import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { PriceGroupSourceAssociationsResponseSchema } from '../../shared/apis/price-group-source-associations.ts';
import type { PriceGroupSourceAssociationsRequest } from '../../shared/apis/price-group-source-associations.ts';
import { PriceGroupResultLookupResponseSchema } from '../../shared/apis/price-group-result-lookup.ts';
import type { PriceGroupResultLookupRequest } from '../../shared/apis/price-group-result-lookup.ts';
import { readPriceGroupSourceAssociationsRoutine, readPriceGroupOperationReceiptRoutine } from './scoped-routine.ts';

type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Price Group source evidence cannot be read safely',
    }),
    'cause',
    { value: cause },
  );

/** Owner-local transaction services. No business handler receives an executor. */
export const priceGroupSourcePersistenceForScope = (
  transaction: Pick<Transaction, 'invoke'>,
  scope: OperationalScope,
) =>
  Effect.succeed({
    list: Effect.fn('PriceGroupSourcePersistence.list')(function* listSourceAssociations(
      input: PriceGroupSourceAssociationsRequest,
    ) {
      const rows = yield* transaction
        .invoke(readPriceGroupSourceAssociationsRoutine, [input])
        .pipe(Effect.mapError(unavailable));
      if (rows.length !== 1) {
        return yield* unavailable();
      }
      const result = yield* Schema.decodeUnknownEffect(PriceGroupSourceAssociationsResponseSchema)(
        rows[0]?.payload,
      ).pipe(Effect.mapError(unavailable));
      if (result.limit !== input.limit || result.offset !== input.offset || result.associations.length > input.limit) {
        return yield* unavailable();
      }
      for (const { priceGroupRef, sourceCorrelation } of result.associations) {
        if (
          priceGroupRef.tenantId !== scope.tenantId ||
          sourceCorrelation.issuer !== input.issuer ||
          sourceCorrelation.routeId !== input.routeId ||
          sourceCorrelation.namespace !== input.namespace ||
          (input.recordKey !== undefined && sourceCorrelation.recordKey !== input.recordKey)
        ) {
          return yield* unavailable();
        }
      }
      return result;
    }),
    recover: Effect.fn('PriceGroupSourcePersistence.recover')(function* recoverSourceOperation(
      input: PriceGroupResultLookupRequest,
      originalPrincipalId?: string,
    ) {
      const query = originalPrincipalId === undefined ? input : { ...input, actingPrincipalId: originalPrincipalId };
      const rows = yield* transaction
        .invoke(readPriceGroupOperationReceiptRoutine, [query])
        .pipe(Effect.mapError(unavailable));
      if (rows.length !== 1) {
        return yield* unavailable();
      }
      const result = yield* Schema.decodeUnknownEffect(PriceGroupResultLookupResponseSchema)(rows[0]?.payload).pipe(
        Effect.mapError(unavailable),
      );
      const matches =
        result.outcome === 'PRICE_GROUP_OPERATION_FOUND'
          ? result.receipt.actionInvocationId === input.actionInvocationId &&
            result.receipt.priceGroupRef.tenantId === scope.tenantId
          : result.actionInvocationId === input.actionInvocationId;
      return matches ? result : yield* unavailable();
    }),
  });
