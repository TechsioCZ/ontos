import { executeCreateProductUnitWithAuthorization } from '@app/catalog/api/client';
import { executeCreateMarketWithAuthorization } from '@app/commerce-market-catalog/api/client';
import { Effect, Redacted, Schema } from 'effect';

export class InternalC14PriceInputBootstrapUnavailable extends Schema.TaggedError<InternalC14PriceInputBootstrapUnavailable>()(
  'InternalC14PriceInputBootstrapUnavailable',
  {
    cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())),
    reason: Schema.String,
  },
) {}

const unavailable = (cause?: unknown) =>
  new InternalC14PriceInputBootstrapUnavailable({
    cause: Redacted.make(cause),
    reason: 'The actual native Unit and Market setup could not be verified',
  });

type UnitPayload = Parameters<typeof executeCreateProductUnitWithAuthorization>[0];
type MarketPayload = Parameters<typeof executeCreateMarketWithAuthorization>[0];
type UnitOptions = Omit<Parameters<typeof executeCreateProductUnitWithAuthorization>[3], 'intent'>;
type MarketOptions = Parameters<typeof executeCreateMarketWithAuthorization>[3];

/** INTERNAL fixture only: both credentials come from the real Shell setup-human session gateway. */
export interface InternalC14PriceInputBootstrapRequest {
  readonly market: {
    readonly authorization: Redacted.Redacted;
    readonly options: MarketOptions;
    readonly payload: MarketPayload;
    readonly requestCorrelation: string;
  };
  readonly unit: {
    readonly authorization: Redacted.Redacted;
    readonly options: UnitOptions;
    readonly payload: UnitPayload;
    readonly requestCorrelation: string;
  };
}

/**
 * Runs the existing public owner Actions. Callers provide every fixture meaning, actual owner URL,
 * idempotency key and independently authorized human assertion. No source workload is granted here.
 */
export const bootstrapInternalC14PriceInputFacts = Effect.fn('InternalC14PriceInputs.bootstrap')(
  function* bootstrapInternalC14PriceInputFacts(input: InternalC14PriceInputBootstrapRequest) {
    if (input.unit.payload.unitRef.tenantId !== input.market.payload.sellingLegalEntityRef.tenantId) {
      return yield* unavailable();
    }
    const unit = yield* executeCreateProductUnitWithAuthorization(
      input.unit.payload,
      Redacted.value(input.unit.authorization),
      input.unit.requestCorrelation,
      input.unit.options,
    ).pipe(Effect.mapError(unavailable));
    if (
      !('unit' in unit) ||
      unit.unit.moduleId !== input.unit.payload.unitRef.moduleId ||
      unit.unit.resourceType !== input.unit.payload.unitRef.resourceType ||
      unit.unit.resourceId !== input.unit.payload.unitRef.resourceId ||
      unit.unit.tenantId !== input.unit.payload.unitRef.tenantId
    ) {
      return yield* unavailable();
    }
    const market = yield* executeCreateMarketWithAuthorization(
      input.market.payload,
      Redacted.value(input.market.authorization),
      input.market.requestCorrelation,
      input.market.options,
    ).pipe(Effect.mapError(unavailable));
    if (
      market.marketRef.moduleId !== 'commerce.market-catalog' ||
      market.marketRef.resourceType !== 'commerce.market-catalog.market' ||
      market.marketRef.resourceId !== input.market.payload.marketId ||
      market.marketRef.tenantId !== input.market.payload.sellingLegalEntityRef.tenantId
    ) {
      return yield* unavailable();
    }
    return { market, unit };
  },
);
