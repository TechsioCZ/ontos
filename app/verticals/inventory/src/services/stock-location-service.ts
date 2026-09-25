import { Effect, Option, Schema } from 'effect';

import {
  StockLocationCorrelationSchema,
  sameExternalStockLocationKey,
  transitionStockLocation,
} from '../../shared/domain/stock-location.ts';
import type { ExternalStockLocationKey, StockLocationTransition } from '../../shared/domain/stock-location.ts';
import type { StockLocationRef } from '../../shared/resources/stock-location.ts';
import type {
  StockLocationCorrelationReader,
  StockLocationPersistence,
} from '../persistence/stock-location-repository.ts';
import { StockLocationPersistenceRejected } from '../persistence/stock-location-persistence-rejected.ts';
import { StockLocationCorrelationUnresolved } from './stock-location-correlation-unresolved.ts';

export { StockLocationCorrelationUnresolved } from './stock-location-correlation-unresolved.ts';

const correlationUnavailable = (source: ExternalStockLocationKey, cause: unknown) => {
  const failure = new StockLocationCorrelationUnresolved({ reason: 'CORRELATION_READER_UNAVAILABLE', source });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export const makeStockLocationCorrelationResolver = (reader: StockLocationCorrelationReader) => ({
  resolve: (
    source: ExternalStockLocationKey,
  ): Effect.Effect<
    {
      readonly correlation: typeof StockLocationCorrelationSchema.Type;
      readonly locationRef: StockLocationRef;
      readonly source: ExternalStockLocationKey;
      readonly status: 'RESOLVED';
    },
    StockLocationCorrelationUnresolved
  > =>
    reader.readExplicit(source).pipe(
      Effect.mapError((cause) => correlationUnavailable(source, cause)),
      Effect.flatMap((correlations) => {
        if (correlations.length === 0) {
          return Effect.fail(new StockLocationCorrelationUnresolved({ reason: 'NO_EXPLICIT_CORRELATION', source }));
        }
        if (correlations.length !== 1) {
          return Effect.fail(
            new StockLocationCorrelationUnresolved({ reason: 'AMBIGUOUS_EXPLICIT_CORRELATION', source }),
          );
        }
        const [correlation] = correlations;
        if (
          correlation === undefined ||
          !Schema.is(StockLocationCorrelationSchema)(correlation) ||
          !sameExternalStockLocationKey(correlation.source, source)
        ) {
          return Effect.fail(
            new StockLocationCorrelationUnresolved({ reason: 'INVALID_EXPLICIT_CORRELATION', source }),
          );
        }
        return Effect.succeed({
          correlation,
          locationRef: correlation.locationRef,
          source: correlation.source,
          status: 'RESOLVED' as const,
        });
      }),
    ),
});

/** Owner-local orchestration over a transaction-scoped persistence implementation. */
export const makeStockLocationService = (persistence: StockLocationPersistence) => ({
  create: persistence.create,
  read: persistence.read,
  readHistory: persistence.readHistory,
  transition: Effect.fn('makeStockLocationService.transition')(function* transitionCurrentLocation(
    ref: StockLocationRef,
    transition: StockLocationTransition,
  ) {
    const possibleCurrent = yield* persistence.read(ref);
    if (Option.isNone(possibleCurrent)) {
      return yield* new StockLocationPersistenceRejected({ locationRef: ref, reason: 'NOT_FOUND' });
    }
    const current = possibleCurrent.value;
    const next = yield* transitionStockLocation(current, transition);
    return yield* persistence.saveTransition({ expectedRevision: current.revision, next });
  }),
});
