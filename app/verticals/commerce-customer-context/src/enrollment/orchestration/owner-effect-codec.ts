import { Effect, Schema } from 'effect';

import { ReconcileEnrollmentResolutionSchema } from '../../../shared/enrollment-contracts.ts';
import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import { withCause } from '../attempts/errors.ts';
import { CommerceEnrollmentOwnerEffectOutcomeSchema } from './owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerEffectOutcome } from './owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerEffectIndeterminate,
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from './owner-transition-errors.ts';
import type { CommerceEnrollmentOwnerEffectError } from './owner-transition-errors.ts';

/**
 * The shared wire seam every owner adapter speaks: a bounded typed failure, and a draft decoded
 * through the driver's own schemas before it can leave the adapter. Each adapter supplies its own
 * `code`, so the vocabulary stays owner-specific while the encoding rule stays single-sourced.
 */

const ownerFields = (code: string, reason: string) => ({ code: code.slice(0, 200), reason: reason.slice(0, 500) });

const withOptionalCause = <Value extends object>(value: Value, cause: unknown): Value =>
  cause === undefined ? value : withCause(value, cause);

export const ownerUnavailable = (
  code: string,
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable> =>
  withOptionalCause(new CommerceEnrollmentOwnerEffectUnavailable(ownerFields(code, reason)), cause);

export const ownerIndeterminate = (
  code: string,
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentOwnerEffectIndeterminate> =>
  withOptionalCause(new CommerceEnrollmentOwnerEffectIndeterminate(ownerFields(code, reason)), cause);

export const ownerRejected = (
  code: string,
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentOwnerEffectRejected> =>
  withOptionalCause(new CommerceEnrollmentOwnerEffectRejected(ownerFields(code, reason)), cause);

/** Wire-shaped drafts, decoded through the owner schemas before they can leave an adapter. */
export interface OwnerOutcomeDraft {
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly nextState?: string;
  readonly outcomeCode: string;
  readonly resultReference?: string;
  readonly status: 'FAILED' | 'SUCCEEDED';
}

export interface OwnerResolutionDraft extends OwnerOutcomeDraft {
  readonly actorPrincipalId: string;
  readonly reconciliationRef: string;
}

export const decodeOwnerOutcome = (
  draft: OwnerOutcomeDraft,
  code: string,
  reason: string,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> =>
  Schema.decodeUnknownEffect(CommerceEnrollmentOwnerEffectOutcomeSchema, { onExcessProperty: 'error' })(draft).pipe(
    Effect.mapError((cause) => ownerUnavailable(code, reason, cause)),
  );

export const decodeOwnerResolution = (
  draft: OwnerResolutionDraft,
  code: string,
  reason: string,
): Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> =>
  Schema.decodeUnknownEffect(ReconcileEnrollmentResolutionSchema, { onExcessProperty: 'error' })(draft).pipe(
    Effect.mapError((cause) => ownerUnavailable(code, reason, cause)),
  );

/** Decode one owner-supplied field, reporting an unusable value as a retryable owner failure. */
export const decodeOwnerField = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the owner wire boundary; the value is decoded before it reaches any Attempt phase.
  value: unknown,
  code: string,
  reason: string,
): Effect.Effect<Value, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((cause) => ownerUnavailable(code, reason, cause)));
