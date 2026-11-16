import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { Effect } from 'effect';

import type {
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import { observations } from '../database/schema.ts';
import { returnSourceBindingKey } from '../domain/refund-prior-returns.ts';

/** A correction recorded from a configured authority states something; refusals state nothing. */
const QUALIFIED_CORRECTION_OUTCOMES: ReadonlySet<PaymentObservationAcceptanceOutcome> = new Set([
  'ACCEPTED_OBSERVATION',
  'HELD_UNRESOLVED',
  'CONFLICT',
]);

export interface DisproofTargetRow {
  readonly amountMinor: number | null;
  readonly observationId: string;
  readonly paymentId: string | null;
  readonly sourceAuthorityId: string | null;
}
export interface DisproofCorrectionRow {
  readonly acceptanceOutcome: PaymentObservationAcceptanceOutcome;
  readonly accountRef: string;
  readonly amountMinor: number | null;
  readonly capabilityCorrelated: boolean | null;
  readonly correctsObservationId: string | null;
  readonly currency: string | null;
  readonly economicEffectKey: string | null;
  readonly environment: string;
  readonly factKind: PaymentObservationFactKind;
  readonly operationId: string | null;
  readonly paymentId: string | null;
  readonly sourceAuthorityId: string | null;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
}

export const disproofCorrectionColumns = {
  acceptanceOutcome: observations.acceptanceOutcome,
  accountRef: observations.accountRef,
  amountMinor: observations.amountMinor,
  capabilityCorrelated: observations.capabilityCorrelated,
  correctsObservationId: observations.correctsObservationId,
  currency: observations.currency,
  economicEffectKey: observations.economicEffectKey,
  environment: observations.environment,
  factKind: observations.factKind,
  operationId: observations.operationId,
  paymentId: observations.paymentId,
  sourceAuthorityId: observations.sourceAuthorityId,
  sourceKind: observations.sourceKind,
  sourceSystem: observations.sourceSystem,
};

/**
 * The one rule for "this statement is fully disproven" (#1151/#1152), shared by every reader: a qualified
 * SOURCE_CORRECTION of the same Payment, issued by the statement's own authority, capability-proven where
 * its source must prove one, that retracts all of it (no amount, or at least the statement's amount).
 * An unapplied correction may still disprove its target unless the same qualified correction effect
 * was accepted for a different target. Partial corrections and foreign authorities never disprove.
 */
const fullyDisproves = (correction: DisproofCorrectionRow, target: DisproofTargetRow): boolean =>
  correction.factKind === 'SOURCE_CORRECTION' &&
  QUALIFIED_CORRECTION_OUTCOMES.has(correction.acceptanceOutcome) &&
  target.paymentId !== null &&
  target.sourceAuthorityId !== null &&
  correction.paymentId === target.paymentId &&
  correction.sourceAuthorityId === target.sourceAuthorityId &&
  correction.capabilityCorrelated !== false &&
  (target.amountMinor === null || correction.amountMinor === null || correction.amountMinor >= target.amountMinor);

/** The same source-scoped correction identity the interpreter uses within an operation. */
const correctionIdentity = (correction: DisproofCorrectionRow): string | undefined =>
  correction.economicEffectKey === null || correction.operationId === null
    ? undefined
    : [
        correction.paymentId,
        correction.operationId,
        returnSourceBindingKey(correction),
        correction.economicEffectKey,
        correction.amountMinor,
        correction.currency,
      ].join('\u0000');

/** The targets that at least one of the given corrections fully disproves. */
export const fullyDisprovenTargets = (
  targets: readonly DisproofTargetRow[],
  corrections: readonly DisproofCorrectionRow[],
): ReadonlySet<string> => {
  const targetOf = new Map(targets.map((target) => [target.observationId, target]));
  const acceptedTargetsByIdentity = new Map<string, Set<string>>();
  for (const correction of corrections) {
    if (
      correction.factKind !== 'SOURCE_CORRECTION' ||
      correction.acceptanceOutcome !== 'ACCEPTED_OBSERVATION' ||
      correction.correctsObservationId === null
    ) {
      continue;
    }
    const identity = correctionIdentity(correction);
    if (identity !== undefined) {
      const acceptedTargets = acceptedTargetsByIdentity.get(identity) ?? new Set<string>();
      acceptedTargets.add(correction.correctsObservationId);
      acceptedTargetsByIdentity.set(identity, acceptedTargets);
    }
  }
  const disproven = new Set<string>();
  for (const correction of corrections) {
    const target =
      correction.correctsObservationId === null ? undefined : targetOf.get(correction.correctsObservationId);
    if (target !== undefined && fullyDisproves(correction, target)) {
      const identity = correctionIdentity(correction);
      const acceptedTargets = identity === undefined ? undefined : acceptedTargetsByIdentity.get(identity);
      if (
        correction.acceptanceOutcome !== 'ACCEPTED_OBSERVATION' &&
        acceptedTargets !== undefined &&
        !acceptedTargets.has(target.observationId)
      ) {
        continue;
      }
      disproven.add(target.observationId);
    }
  }
  return disproven;
};

export const selectFullyDisprovenTargets = Effect.fn('PaymentEvidence.selectFullyDisprovenTargets')(
  function* selectFullyDisprovenTargets(
    transaction: ScopedTransactionExecutor,
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    observationIds: readonly string[],
  ) {
    if (observationIds.length === 0) {
      return new Set<string>();
    }
    const ofScope = and(eq(observations.tenantId, scope.tenantId), eq(observations.legalEntityId, scope.legalEntityId));
    const targetFilter = and(ofScope, inArray(observations.observationId, [...observationIds]));
    const targetPayments = transaction
      .select({ paymentId: observations.paymentId })
      .from(observations)
      .where(targetFilter);
    const [targets, corrections] = yield* Effect.all(
      [
        transaction
          .select({
            amountMinor: observations.amountMinor,
            observationId: observations.observationId,
            paymentId: observations.paymentId,
            sourceAuthorityId: observations.sourceAuthorityId,
          })
          .from(observations)
          .where(targetFilter),
        transaction
          .select(disproofCorrectionColumns)
          .from(observations)
          .where(
            and(
              ofScope,
              eq(observations.factKind, 'SOURCE_CORRECTION'),
              or(
                inArray(observations.correctsObservationId, [...observationIds]),
                and(
                  eq(observations.acceptanceOutcome, 'ACCEPTED_OBSERVATION'),
                  inArray(observations.paymentId, targetPayments),
                  isNotNull(observations.economicEffectKey),
                ),
              ),
            ),
          ),
      ],
      { concurrency: 1 },
    );
    return fullyDisprovenTargets(targets, corrections);
  },
);
