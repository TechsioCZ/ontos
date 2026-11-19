import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';

import type { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { observationIdOf } from '../domain/history/provider-observation.ts';
import type { ProviderObservationInput } from '../domain/history/provider-observation.ts';
import { ObservationEvidenceSchema } from '../domain/history/vocabulary.ts';
import type { LinkReasonCodeSchema } from '../domain/history/vocabulary.ts';
import { storeUnavailable } from '../handoff/process-intent-handoff.ts';
import {
  ingestProviderObservationRoutine,
  workerLinkRetryAttemptRoutine,
} from '../persistence/communications-routines.ts';

/**
 * What the owner does with a provider observation and a retry link (#1402). Both go through a scoped routine, so the binding
 * of the Tenant, the intent and the attempt is decided by the database in the same statement that writes, and neither can
 * create, finish or schedule an attempt: an observation can never cause a second send.
 */

/**
 * The answer to one observation. None of the refusals carries a value of a row: the same `UNBOUND` is given for another
 * Tenant's intent, an unknown intent and an attempt of another intent, so a caller learns nothing about foreign data.
 * - RECORDED: appended;  DUPLICATE: the same observation again, nothing changes;
 * - CONFLICT: the same identity (attempt, provider, key AND evidence kind) with another content, including another claimed
 *   time: the first one stays untouched and the disagreement is kept as a trace (the history then needs reconciliation);
 *   the same key with ANOTHER evidence kind is not a conflict but a new observation (a bounce after an acceptance);
 * - UNBOUND: Tenant, intent and attempt do not belong together;
 * - NOT_SUBMITTED: the attempt provably submitted nothing, so there is nothing to observe;
 * - PROVIDER_MISMATCH: another provider identity than the one the attempt is bound to.
 */
export const IngestAnswerSchema = Schema.Struct({
  outcome: Schema.Literals(['CONFLICT', 'DUPLICATE', 'NOT_SUBMITTED', 'PROVIDER_MISMATCH', 'RECORDED', 'UNBOUND']),
});

export const ingestProviderObservation = Effect.fn('Communications.ingestProviderObservation')(function* ingest(
  invoker: ScopedRoutineInvoker,
  observation: ProviderObservationInput,
) {
  const observationId = yield* observationIdOf(observation);
  const evidence = yield* Schema.encodeEffect(ObservationEvidenceSchema)(observation.evidence).pipe(Effect.orDie);
  const rows = yield* invoker
    .invoke(ingestProviderObservationRoutine, [
      observation.tenantId,
      observation.intentId,
      observation.attemptId,
      observationId,
      observation.providerKey,
      observation.observationKey,
      observation.providerRef ?? null,
      observation.evidence.kind,
      DateTime.formatIso(observation.observedAt),
      { ...evidence },
    ])
    .pipe(Effect.mapError((cause) => storeUnavailable('The provider observation could not be recorded', cause)));
  const answer = yield* Schema.decodeUnknownEffect(IngestAnswerSchema)(rows[0]?.result).pipe(
    Effect.mapError((cause) => storeUnavailable('The provider observation answer was unreadable', cause)),
  );
  return answer.outcome;
});

/**
 * Why a later attempt follows an earlier one of the SAME intent: nothing was submitted (including no request made for want of
 * a usable configuration), the provider provably refused it, or a reconciliation proved non-acceptance of an unknown effect.
 */
export type RetryBasis =
  | { readonly kind: 'PRIOR_NOT_ATTEMPTED' }
  | { readonly kind: 'PRIOR_REJECTED' }
  | { readonly kind: 'RECONCILED_NON_ACCEPTANCE'; readonly observationId: string };

export interface RetryLinkInput {
  readonly attemptId: typeof DeliveryAttemptIdSchema.Type;
  readonly basis: RetryBasis;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly previousAttemptId: typeof DeliveryAttemptIdSchema.Type;
  readonly reasonCode: typeof LinkReasonCodeSchema.Type;
}

export const RetryLinkAnswerSchema = Schema.Struct({
  outcome: Schema.Literals(['BASIS_MISSING', 'CONFLICT', 'EXISTS', 'LINKED', 'MISSING', 'NOT_FINISHED', 'ORDER']),
});

/** Records the structural link of a Technical Retry (a later attempt of the same intent); it decides nothing about eligibility. */
export const linkRetryAttempt = Effect.fn('Communications.linkRetryAttempt')(function* link(
  invoker: ScopedRoutineInvoker,
  input: RetryLinkInput,
) {
  const rows = yield* invoker
    .invoke(workerLinkRetryAttemptRoutine, [
      input.intentId,
      input.attemptId,
      input.previousAttemptId,
      input.reasonCode,
      input.basis.kind,
      input.basis.kind === 'RECONCILED_NON_ACCEPTANCE' ? input.basis.observationId : null,
    ])
    .pipe(Effect.mapError((cause) => storeUnavailable('The retry link could not be recorded', cause)));
  const answer = yield* Schema.decodeUnknownEffect(RetryLinkAnswerSchema)(rows[0]?.result).pipe(
    Effect.mapError((cause) => storeUnavailable('The retry link answer was unreadable', cause)),
  );
  return answer.outcome;
});
