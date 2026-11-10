import type {
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
} from '../../shared/domain/payment-vocabulary.ts';

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
  readonly amountMinor: number | null;
  readonly capabilityCorrelated: boolean | null;
  readonly correctsObservationId: string | null;
  readonly factKind: PaymentObservationFactKind;
  readonly paymentId: string | null;
  readonly sourceAuthorityId: string | null;
}

/**
 * The one rule for "this statement is fully disproven" (#1151/#1152), shared by every reader: a qualified
 * SOURCE_CORRECTION of the same Payment, issued by the statement's own authority, capability-proven where
 * its source must prove one, that retracts all of it (no amount, or at least the statement's amount).
 * Whether the correction changed an outcome when it arrived does not matter; partial corrections and
 * corrections that name another Payment or come from another authority never disprove.
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

/** The targets that at least one of the given corrections fully disproves. */
export const fullyDisprovenTargets = (
  targets: readonly DisproofTargetRow[],
  corrections: readonly DisproofCorrectionRow[],
): ReadonlySet<string> => {
  const targetOf = new Map(targets.map((target) => [target.observationId, target]));
  const disproven = new Set<string>();
  for (const correction of corrections) {
    const target =
      correction.correctsObservationId === null ? undefined : targetOf.get(correction.correctsObservationId);
    if (target !== undefined && fullyDisproves(correction, target)) {
      disproven.add(target.observationId);
    }
  }
  return disproven;
};
