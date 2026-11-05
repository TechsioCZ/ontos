import { Effect, Schema } from 'effect';

import type { DecisionOutcome } from '../model.ts';
import type { AccessDecision } from './contract.ts';
import { withOptional } from './optional.ts';

export const LegacyAuthorizationResultSchema = Schema.Literals(['allowed', 'denied']);
export type LegacyAuthorizationResult = typeof LegacyAuthorizationResultSchema.Type;

/**
 * Legacy behaviours that are recorded, never copied (O40). A mismatch explained by one of them is
 * still a difference to resolve before cutover; it is not a reason to change the v2 answer.
 */
export const KNOWN_LEGACY_QUIRKS = ['action_restriction_subject_type_mismatch', 'global_action_identity'] as const;
export type LegacyAuthorizationQuirk = (typeof KNOWN_LEGACY_QUIRKS)[number];

export interface ShadowObservation {
  readonly actorId: string;
  readonly candidate: AccessDecision;
  readonly capabilityKey?: string;
  readonly entrypointKey: string;
  readonly legacy: LegacyAuthorizationResult;
  readonly legacyReason?: string;
  readonly now: Date;
  /** Stable identity of the recorded observation; the wiring lane assigns it once. */
  readonly observationId: string;
  /** Legacy quirks that the wiring lane attributes to this entrypoint while recording the run. */
  readonly recordedQuirks?: readonly LegacyAuthorizationQuirk[];
}

export const ShadowComparisonStatusSchema = Schema.Literals(['agree', 'inconclusive', 'legacy_quirk', 'mismatch']);
export type ShadowComparisonStatus = typeof ShadowComparisonStatusSchema.Type;
export const ShadowMismatchDirectionSchema = Schema.Literals(['v2_narrower', 'v2_wider']);
export type ShadowMismatchDirection = typeof ShadowMismatchDirectionSchema.Type;

export interface ShadowComparison {
  readonly actorId: string;
  readonly candidateOutcome: DecisionOutcome;
  readonly capabilityKey?: string;
  /** Only a mismatch names a direction; the v2 answer always grants nothing in shadow mode. */
  readonly direction?: ShadowMismatchDirection;
  readonly entrypointKey: string;
  readonly legacy: LegacyAuthorizationResult;
  readonly legacyReason?: string;
  readonly observationId: string;
  readonly observedAt: Date;
  readonly quirks: readonly LegacyAuthorizationQuirk[];
  readonly reasonCodes: readonly string[];
  readonly status: ShadowComparisonStatus;
}

const directionOf = (
  legacy: LegacyAuthorizationResult,
  candidate: DecisionOutcome,
): ShadowMismatchDirection | undefined => {
  if (candidate === 'UNAVAILABLE') {
    return undefined;
  }
  const candidateAllows = candidate === 'ALLOWED';
  if (legacy === 'allowed' && !candidateAllows) {
    return 'v2_narrower';
  }
  return legacy === 'denied' && candidateAllows ? 'v2_wider' : undefined;
};

const statusOf = (
  candidate: DecisionOutcome,
  direction: ShadowMismatchDirection | undefined,
  quirks: readonly LegacyAuthorizationQuirk[],
): ShadowComparisonStatus => {
  if (candidate === 'UNAVAILABLE') {
    return 'inconclusive';
  }
  if (direction === undefined) {
    return 'agree';
  }
  return quirks.length === 0 ? 'mismatch' : 'legacy_quirk';
};

/**
 * Compares one legacy answer with the v2 decision without changing either. UNAVAILABLE is
 * inconclusive, never a mismatch; a mismatch never flips the live decision in tranche 1.
 */
export const compareShadowDecision = (observation: ShadowObservation): ShadowComparison => {
  const direction = directionOf(observation.legacy, observation.candidate.outcome);
  const quirks = observation.recordedQuirks ?? [];
  const status = statusOf(observation.candidate.outcome, direction, quirks);
  return withOptional(
    withOptional(
      withOptional(
        {
          actorId: observation.actorId,
          candidateOutcome: observation.candidate.outcome,
          entrypointKey: observation.entrypointKey,
          legacy: observation.legacy,
          observationId: observation.observationId,
          observedAt: observation.now,
          quirks,
          reasonCodes: observation.candidate.reasons.map(({ code }) => code),
          status,
        },
        'capabilityKey',
        observation.capabilityKey,
      ),
      'direction',
      direction,
    ),
    'legacyReason',
    observation.legacyReason,
  );
};

export interface ShadowComparisonRecorder {
  readonly record: (comparison: ShadowComparison) => Effect.Effect<void>;
}

export interface ShadowComparator {
  readonly compare: (observation: ShadowObservation) => ShadowComparison;
  readonly compareAndRecord: (observation: ShadowObservation) => Effect.Effect<ShadowComparison>;
}

/**
 * The API the later wiring lane calls next to every legacy decision. Recording is the only effect;
 * nothing here can allow, deny or change a live request.
 */
const compareAndRecordEffect = Effect.fn('ShadowComparator.compareAndRecord')(function* compareAndRecordProgram(
  recorder: ShadowComparisonRecorder,
  observation: ShadowObservation,
) {
  const comparison = compareShadowDecision(observation);
  yield* recorder.record(comparison);
  return comparison;
});

export const makeShadowComparator = (recorder: ShadowComparisonRecorder): ShadowComparator => ({
  compare: compareShadowDecision,
  compareAndRecord: (observation) => compareAndRecordEffect(recorder, observation),
});
