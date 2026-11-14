import type { ReadServiceFactory, ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import { OperationContextUnavailable, defineScopedRoutine } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { MarketLifecycleResultSchema } from '../../shared/action-contracts.ts';
import { MarketRetirementSourceInvocationIdSchema } from '../../shared/domain/market-retirement-impact.ts';
import type { MarketCatalogReadPersistenceUnavailable } from './market-history-routine.ts';
import { marketCatalogReadUnavailable as unavailable } from './market-history-routine.ts';

const StateRowSchema = Schema.Struct({ payload: Schema.Unknown });
const UuidSchema = Schema.String.check(Schema.isUUID());
const MarketIdSchema = UuidSchema.pipe(
  Schema.brand('CommerceMarketAdministrationMarketId'),
  Schema.decodeTo(UuidSchema),
);
const DefinitionRevisionIdSchema = UuidSchema.pipe(
  Schema.brand('CommerceMarketAdministrationDefinitionRevisionId'),
  Schema.decodeTo(UuidSchema),
);

const readMarketAdministrationStateRoutine = defineScopedRoutine({
  name: 'read_market_administration_state',
  ownerModuleKey: 'commerce.market-catalog',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: StateRowSchema,
  routineKey: 'market-catalog-read.administration-state',
  schema: 'commerce_market_catalog',
});

/**
 * The newest native retirement admission of one Market, exactly as the owner routine returns it. `result` is the
 * committed Market lifecycle result the original retirement already produced; it is absent while the admission is
 * `PENDING` or was `ABORTED`.
 */
export const MarketRetirementAdmissionRowSchema = Schema.Struct({
  result: Schema.optionalKey(MarketLifecycleResultSchema),
  sourceActionInvocationId: MarketRetirementSourceInvocationIdSchema,
  status: Schema.Literals(['PENDING', 'COMMITTED', 'ABORTED']),
});
export type MarketRetirementAdmissionRow = typeof MarketRetirementAdmissionRowSchema.Type;

/** Owner state of one Market of the trusted company, exactly as the owner routine returns it. */
export const MarketAdministrationStateRowSchema = Schema.Struct({
  currentDefinitionRevisionId: DefinitionRevisionIdSchema,
  marketId: MarketIdSchema,
  retirementAdmission: Schema.optionalKey(MarketRetirementAdmissionRowSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type MarketAdministrationStateRow = typeof MarketAdministrationStateRowSchema.Type;

export interface MarketAdministrationStatePersistence {
  /** None when the Market does not exist for the trusted company. */
  readonly state: (
    marketId: string,
  ) => Effect.Effect<Option.Option<MarketAdministrationStateRow>, MarketCatalogReadPersistenceUnavailable>;
}

export const marketAdministrationStateForInvoker = (
  invoker: ScopedRoutineInvoker,
): MarketAdministrationStatePersistence => ({
  state: Effect.fn('MarketAdministrationStatePersistence.state')(function* state(marketId: string) {
    const rows = yield* invoker
      .invoke(readMarketAdministrationStateRoutine, [{ marketId }])
      .pipe(Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)));
    if (rows.length > 1) {
      return yield* unavailable('The Market administration state routine returned more than one Market');
    }
    const [row] = rows;
    if (row === undefined) {
      return Option.none();
    }
    return Option.some(
      yield* Schema.decodeUnknownEffect(MarketAdministrationStateRowSchema)(row.payload).pipe(
        Effect.mapError(unavailable),
      ),
    );
  }),
});

export const marketAdministrationStateForScope: ReadServiceFactory<MarketAdministrationStatePersistence> = (
  transaction,
  scope,
) =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Market administration state requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(marketAdministrationStateForInvoker(transaction));
