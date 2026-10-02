import type { ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { OperationContextUnavailable, defineScopedRoutine } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';

import type { PricingCurrentMarketEvidenceRequest } from '../../shared/apis/pricing-current-market-evidence.ts';
import { EffectivePeriodSchema, MarketDefinitionSchema } from '../../shared/market-contracts.ts';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

const PricingCurrentMarketSnapshotSchema = Schema.Struct({
  definitionRevisionRef: Schema.optionalKey(boundedReason),
  effectivePeriod: Schema.optionalKey(EffectivePeriodSchema),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lifecycleRevisionRef: Schema.optionalKey(boundedReason),
  market: Schema.optionalKey(MarketDefinitionSchema),
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  observedAt: Schema.DateTimeUtcFromString,
  reason: Schema.optionalKey(boundedReason),
  state: Schema.Literals(['PRESENT', 'ABSENT', 'CONFLICT', 'MISSING', 'UNVERIFIABLE']),
});
export type PricingCurrentMarketSnapshot = typeof PricingCurrentMarketSnapshotSchema.Type;

const SnapshotRowSchema = Schema.Struct({ payload: PricingCurrentMarketSnapshotSchema });

const readPricingCurrentMarketEvidenceRoutine = defineScopedRoutine({
  name: 'read_pricing_current_market_evidence',
  ownerModuleKey: 'commerce.market-catalog',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: SnapshotRowSchema,
  routineKey: 'pricing-current-market-evidence.read-current',
  schema: 'commerce_market_catalog',
});

export class PricingCurrentMarketEvidencePersistenceUnavailable extends Schema.TaggedError<PricingCurrentMarketEvidencePersistenceUnavailable>()(
  'PricingCurrentMarketEvidencePersistenceUnavailable',
  {
    reason: boundedReason,
  },
) {}

export interface PricingCurrentMarketEvidencePersistence {
  readonly readCurrent: (
    request: PricingCurrentMarketEvidenceRequest,
  ) => Effect.Effect<PricingCurrentMarketSnapshot, PricingCurrentMarketEvidencePersistenceUnavailable>;
}

const unavailable = (cause?: unknown): PricingCurrentMarketEvidencePersistenceUnavailable => {
  const failure = new PricingCurrentMarketEvidencePersistenceUnavailable({
    reason: 'Commerce Market current-source evidence is temporarily unavailable',
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const inputFor = (request: PricingCurrentMarketEvidenceRequest) => ({
  channel: request.commercialScope.channel,
  effectiveAt: DateTime.formatIso(request.effectiveAt),
  marketId: request.commercialScope.marketRef.resourceId,
});

const persistenceForTransaction = (
  transaction: Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0],
): PricingCurrentMarketEvidencePersistence => ({
  readCurrent: (request) =>
    transaction.invoke(readPricingCurrentMarketEvidenceRoutine, [inputFor(request)]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(unavailable('The owner current-source routine returned no snapshot'))
          : Effect.succeed(row.payload),
      ),
    ),
});

export const pricingCurrentMarketEvidencePersistenceForScope: ReadServiceFactory<
  PricingCurrentMarketEvidencePersistence
> = (transaction, scope) =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Pricing Market evidence requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(persistenceForTransaction(transaction));
