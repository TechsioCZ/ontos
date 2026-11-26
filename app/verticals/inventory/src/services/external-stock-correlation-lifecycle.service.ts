import type { Effect as EffectType } from 'effect';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ExternalStockCorrelationRejected } from '../../shared/domain/external-stock-correlation-rejected.ts';
import {
  ExternalStockCorrelationSchema,
  ExternalStockItemTargetSchema,
  ExternalStockLocationTargetSchema,
} from '../../shared/domain/external-stock-correlation.ts';
import type {
  ConfirmExternalStockCorrelationInput,
  CorrectExternalStockCorrelationInput,
  EndExternalStockCorrelationInput,
  EstablishExternalStockCorrelationInput,
  ExternalStockCorrelation,
  ExternalStockCorrelationPersistence,
  ExternalStockKey,
  ExternalStockTarget,
} from '../../shared/domain/external-stock-correlation.ts';

const rejected = (
  reason: ExternalStockCorrelationRejected['reason'],
  correlationRef?: ExternalStockCorrelation['correlationRef'],
) =>
  correlationRef === undefined
    ? new ExternalStockCorrelationRejected({ code: 'external_stock_correlation_rejected', reason })
    : new ExternalStockCorrelationRejected({
        code: 'external_stock_correlation_rejected',
        correlationRef,
        reason,
      });

const rejectedFromCause = (
  cause: unknown,
  reason: ExternalStockCorrelationRejected['reason'],
  correlationRef?: ExternalStockCorrelation['correlationRef'],
) => {
  const failure = rejected(reason, correlationRef);
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const sameTarget = (left: ExternalStockTarget, right: ExternalStockTarget): boolean => {
  if (Schema.is(ExternalStockItemTargetSchema)(left) && Schema.is(ExternalStockItemTargetSchema)(right)) {
    return left.ref.tenantId === right.ref.tenantId && left.ref.resourceId === right.ref.resourceId;
  }
  if (Schema.is(ExternalStockLocationTargetSchema)(left) && Schema.is(ExternalStockLocationTargetSchema)(right)) {
    return left.ref.tenantId === right.ref.tenantId && left.ref.resourceId === right.ref.resourceId;
  }
  return false;
};

const makeCandidate = (
  makeCorrelationId: () => string,
  input: {
    readonly effectiveFrom: ExternalStockCorrelation['effectivePeriod']['from'];
    readonly externalKey: ExternalStockKey;
    readonly ownerEvidenceRef: string;
    readonly target: ExternalStockTarget;
  },
) =>
  Schema.decodeEffect(ExternalStockCorrelationSchema)({
    confirmedAt: input.effectiveFrom,
    correlationRef: {
      moduleId: 'commerce.inventory',
      resourceId: makeCorrelationId(),
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId: input.externalKey.tenantId,
    },
    effectivePeriod: {
      from: input.effectiveFrom,
      to: null,
    },
    externalKey: input.externalKey,
    lifecycle: 'CURRENT',
    ownerEvidenceRef: input.ownerEvidenceRef,
    revision: 1,
    target: input.target,
  }).pipe(Effect.mapError((cause) => rejectedFromCause(cause, 'INVALID_CORRELATION')));

const requireOneCurrent = (
  candidates: readonly ExternalStockCorrelation[],
): EffectType.Effect<ExternalStockCorrelation, ExternalStockCorrelationRejected> => {
  const [candidate] = candidates;
  if (candidate === undefined) {
    return Effect.fail(rejected('CORRELATION_NOT_FOUND'));
  }
  if (candidates.length !== 1) {
    return Effect.fail(rejected('AMBIGUOUS_EFFECTIVE_CORRELATION'));
  }
  return candidate.lifecycle === 'CURRENT'
    ? Effect.succeed(candidate)
    : Effect.fail(rejected('CORRELATION_NOT_CURRENT', candidate.correlationRef));
};

/**
 * Owner-governed lifecycle. Correction closes the old half-open period and creates a different
 * correlation identity; it never rewrites the old target or its historical meaning.
 */
const makeExternalStockCorrelationLifecycle = (
  persistence: ExternalStockCorrelationPersistence,
  options: { readonly makeCorrelationId: () => string },
) => ({
  confirm: (input: ConfirmExternalStockCorrelationInput) =>
    persistence.findByRef(input.correlationRef).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(rejected('CORRELATION_NOT_FOUND', input.correlationRef)),
          onSome: (current) =>
            current.lifecycle === 'CURRENT'
              ? Schema.decodeEffect(ExternalStockCorrelationSchema)({
                  ...current,
                  confirmedAt: input.confirmedAt,
                  ownerEvidenceRef: input.ownerEvidenceRef,
                  revision: current.revision + 1,
                }).pipe(
                  Effect.mapError((cause) => rejectedFromCause(cause, 'INVALID_CORRELATION', current.correlationRef)),
                  Effect.flatMap((next) => persistence.saveConfirmation({ expectedRevision: current.revision, next })),
                )
              : Effect.fail(rejected('CORRELATION_NOT_CURRENT', current.correlationRef)),
        }),
      ),
    ),
  correct: (input: CorrectExternalStockCorrelationInput) =>
    persistence.findEffective(input.externalKey, input.correctedAt).pipe(
      Effect.flatMap(requireOneCurrent),
      Effect.flatMap((current) => {
        if (current.effectivePeriod.from >= input.correctedAt) {
          return Effect.fail(rejected('INVALID_CORRELATION', current.correlationRef));
        }
        if (sameTarget(current.target, input.target)) {
          return Effect.fail(rejected('TARGET_UNCHANGED', current.correlationRef));
        }
        return makeCandidate(options.makeCorrelationId, {
          effectiveFrom: input.correctedAt,
          externalKey: input.externalKey,
          ownerEvidenceRef: input.ownerEvidenceRef,
          target: input.target,
        }).pipe(
          Effect.flatMap((replacement) =>
            persistence.replaceCurrent({ current, endedAt: input.correctedAt, replacement }),
          ),
        );
      }),
    ),
  end: (input: EndExternalStockCorrelationInput) =>
    persistence.findEffective(input.externalKey, input.endedAt).pipe(
      Effect.flatMap(requireOneCurrent),
      Effect.flatMap((current) =>
        current.effectivePeriod.from < input.endedAt
          ? persistence.endCurrent({ current, endedAt: input.endedAt })
          : Effect.fail(rejected('INVALID_CORRELATION', current.correlationRef)),
      ),
    ),
  establish: (input: EstablishExternalStockCorrelationInput) =>
    persistence
      .findEffective(input.externalKey, input.effectiveFrom)
      .pipe(
        Effect.flatMap((existing) =>
          existing.length === 0
            ? makeCandidate(options.makeCorrelationId, input).pipe(Effect.flatMap(persistence.insertCurrent))
            : Effect.fail(rejected('OVERLAPPING_EFFECTIVE_PERIOD')),
        ),
      ),
});

/** Owner composition of the same transaction-bound lifecycle used by Inventory actions. */
export class ExternalStockCorrelationLifecycle extends Context.Service<
  ExternalStockCorrelationLifecycle,
  ReturnType<typeof makeExternalStockCorrelationLifecycle>
>()('@app/inventory/services/external-stock-correlation-lifecycle.service/ExternalStockCorrelationLifecycle') {
  static layer(
    persistence: ExternalStockCorrelationPersistence,
    options: Parameters<typeof makeExternalStockCorrelationLifecycle>[1],
  ) {
    return Layer.succeed(
      ExternalStockCorrelationLifecycle,
      makeExternalStockCorrelationLifecycle(persistence, options),
    );
  }
}
