import type {
  PricingFinalPreRoundLine,
  PricingFinalPreRoundReady,
  PricingFinalPreRoundResult,
  PricingRawCompositionReady,
  PricingZeroFloorAuthorizationSet,
  PricingZeroFloorFailed,
} from '@app/pricing-contracts/domain/line-composition';
import { PricingFinalPreRoundReadySchema } from '@app/pricing-contracts/domain/line-composition';
import { Effect, Option, Schema } from 'effect';

import { evaluateZeroFloorAuthorization } from './zero-floor-authorization-evaluator.service.ts';

export interface PricingLineZeroFloorAuthorizationSet {
  readonly authorizationSet: PricingZeroFloorAuthorizationSet;
  readonly occurrenceId: string;
}

export interface PricingLineValueEvaluationInput {
  readonly authorizationSets: readonly PricingLineZeroFloorAuthorizationSet[];
  readonly composition: PricingRawCompositionReady;
}

type FloorEvaluationState =
  | { readonly failure: PricingZeroFloorFailed; readonly kind: 'FAILED' }
  | { readonly kind: 'READY'; readonly lines: readonly PricingFinalPreRoundLine[] };

const invalidFinalResult = (occurrenceId: PricingZeroFloorFailed['occurrenceId']): PricingZeroFloorFailed => ({
  kind: 'ZERO_FLOOR_FAILED',
  occurrenceId,
  reason: 'The guarded pre-round line result did not preserve its exact composition evidence',
  reasonCode: 'AUTHORIZATION_UNVERIFIABLE',
  retryable: false,
});

/**
 * Final #779 boundary: compose exact raw line values, then apply the governed non-negative guard.
 * Publication rounding (#781), totals (#780), Tax, Payment, and Storefront are intentionally absent.
 */
export const evaluatePricingLineValues = Effect.fn('PricingLineValueCalculation.evaluate')(
  function* evaluatePricingLineValuesProgram(
    input: PricingLineValueEvaluationInput,
  ): Effect.fn.Return<PricingFinalPreRoundResult> {
    const { composition } = input;
    const misboundLine = composition.lines.find(
      ({ occurrenceId }, index) => input.authorizationSets[index]?.occurrenceId !== occurrenceId,
    );
    if (input.authorizationSets.length !== composition.lines.length || misboundLine !== undefined) {
      const [firstLine] = composition.lines;
      if (firstLine === undefined) {
        return {
          candidateRef: composition.candidateRef,
          failure: {
            reason: 'Raw composition emitted no original Pricing Lines',
            retryable: false,
            type: 'EVIDENCE_UNVERIFIABLE',
          },
          outcome: 'RAW_COMPOSITION_FAILED',
        };
      }
      return invalidFinalResult(misboundLine?.occurrenceId ?? firstLine.occurrenceId);
    }

    const authorizationSetsByOccurrence = new Map(
      input.authorizationSets.map(({ authorizationSet, occurrenceId }) => [occurrenceId, authorizationSet]),
    );

    const floorState = yield* Effect.reduce(
      composition.lines,
      (): FloorEvaluationState => ({ kind: 'READY', lines: [] }),
      (state, composedLine): Effect.Effect<FloorEvaluationState> => {
        if (state.kind === 'FAILED') {
          return Effect.succeed(state);
        }
        const authorizationSet = authorizationSetsByOccurrence.get(composedLine.occurrenceId);
        if (authorizationSet === undefined) {
          return Effect.succeed({
            failure: invalidFinalResult(composedLine.occurrenceId),
            kind: 'FAILED',
          });
        }
        return evaluateZeroFloorAuthorization({
          authorizationSet,
          composedLine,
          composition,
        }).pipe(
          Effect.map((floorEvaluation): FloorEvaluationState =>
            floorEvaluation.kind === 'ZERO_FLOOR_FAILED'
              ? { failure: floorEvaluation, kind: 'FAILED' }
              : {
                  kind: 'READY',
                  lines: [
                    ...state.lines,
                    {
                      composition: composedLine,
                      floorEvaluation,
                      nonNegativePreRoundValue: floorEvaluation.nonNegativePreRoundValue,
                      occurrenceId: composedLine.occurrenceId,
                    },
                  ],
                },
          ),
        );
      },
    );
    if (floorState.kind === 'FAILED') {
      return floorState.failure;
    }

    const ready: PricingFinalPreRoundReady = {
      decision: composition.decision,
      lines: floorState.lines,
      outcome: 'PRE_ROUND_LINE_VALUES_READY',
      rawComposition: composition,
    };
    const decoded = Schema.decodeOption(PricingFinalPreRoundReadySchema, {
      onExcessProperty: 'error',
    })(ready);
    if (Option.isNone(decoded)) {
      const [firstLine] = composition.lines;
      if (firstLine === undefined) {
        return {
          candidateRef: composition.candidateRef,
          failure: {
            reason: 'Raw composition emitted no original Pricing Lines',
            retryable: false,
            type: 'EVIDENCE_UNVERIFIABLE',
          },
          outcome: 'RAW_COMPOSITION_FAILED',
        };
      }
      return invalidFinalResult(firstLine.occurrenceId);
    }
    return decoded.value;
  },
);
