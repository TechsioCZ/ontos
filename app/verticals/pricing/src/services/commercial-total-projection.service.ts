import type {
  PricingCommercialTotalResult,
  PricingCommercialTotalSafeProjection,
} from '@app/pricing-contracts/domain/commercial-total';
import {
  PricingCommercialTotalFailureCodeSchema,
  PricingCommercialTotalResultSchema,
  PricingCommercialTotalSafeProjectionSchema,
} from '@app/pricing-contracts/domain/commercial-total';
import { Effect, Schema } from 'effect';

export class PricingCommercialTotalProjectionUnverifiable extends Schema.TaggedError<PricingCommercialTotalProjectionUnverifiable>()(
  'PricingCommercialTotalProjectionUnverifiable',
  {
    code: Schema.Union([PricingCommercialTotalFailureCodeSchema, Schema.Literal('PROJECTION_UNVERIFIABLE')]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

const unverifiable = (reason: string, cause: unknown): PricingCommercialTotalProjectionUnverifiable =>
  Object.defineProperty(
    new PricingCommercialTotalProjectionUnverifiable({
      code: 'PROJECTION_UNVERIFIABLE',
      reason,
      retryable: true,
    }),
    'cause',
    {
      configurable: true,
      value: cause,
    },
  );

export const projectPricingCommercialTotal = Effect.fn('PricingCommercialTotalProjection.project')(
  function* projectPricingCommercialTotalProgram(
    result: PricingCommercialTotalResult,
  ): Effect.fn.Return<PricingCommercialTotalSafeProjection, PricingCommercialTotalProjectionUnverifiable> {
    const canonicalResult = yield* Schema.decodeEffect(PricingCommercialTotalResultSchema, {
      onExcessProperty: 'error',
    })(result).pipe(
      Effect.mapError((cause) =>
        unverifiable('The canonical Pricing commercial total is incomplete or internally inconsistent', cause),
      ),
    );

    if (canonicalResult.outcome === 'COMMERCIAL_TOTAL_FAILED') {
      return yield* new PricingCommercialTotalProjectionUnverifiable({
        code: canonicalResult.failure.code,
        reason: canonicalResult.failure.message,
        retryable: canonicalResult.failure.retryable,
      });
    }

    const projection = {
      candidateRef: canonicalResult.candidateRef,
      currencyCode: canonicalResult.pricingNetCommercialTotal.currencyCode,
      lines: canonicalResult.publishedLines.map(({ occurrenceId, publishedLineValue }) => ({
        occurrenceId,
        publishedLineValue,
      })),
      monetaryBoundary: 'PRE_TAX' as const,
      pricingNetCommercialTotal: canonicalResult.pricingNetCommercialTotal,
    };

    return yield* Schema.decodeEffect(PricingCommercialTotalSafeProjectionSchema, {
      onExcessProperty: 'error',
    })(projection).pipe(
      Effect.mapError((cause) =>
        unverifiable('The canonical Pricing commercial total cannot be published as a safe pre-Tax projection', cause),
      ),
    );
  },
);
