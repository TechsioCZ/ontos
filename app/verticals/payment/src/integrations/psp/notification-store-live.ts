import { Effect, Layer, Match, Option, Schema } from 'effect';

import { ProviderNotificationStateSchema } from '../../../shared/domain/psp-vocabulary.ts';
import {
  PspNotificationIdSchema,
  pspReadNotification,
  pspTransitionNotification,
} from '../../persistence/psp-worker-routines.ts';
import type { PspNotificationRecord } from '../../persistence/psp-worker-routines.ts';
import { ledgerUnavailable, routineUnavailable } from './dispatch-ledger-live.ts';
import { ProviderNotificationStore, StoredProviderNotificationSchema } from './notification-store.ts';
import type {
  ProviderNotificationId,
  ProviderNotificationStoreContract,
  ReadProviderNotificationInput,
  TransitionProviderNotificationInput,
} from './notification-store.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';

/**
 * Worker-side access to captured provider notifications over the W1-DB scoped routines (#1157). The
 * captured envelope is immutable; only the processing state and the correlated operation advance.
 *
 * The stored row is mapped back to its `VerifiedNotificationTrigger`: `actionable` is false exactly for a
 * row captured IGNORED, and `signedObject` is the signed event's `data.object` re-read from the exact
 * captured body of an actionable signature-verified capture; every other capture has none.
 */

/** The processing states a worker may move a notification to; capture alone writes CAPTURED or IGNORED. */
const ProcessingStateSchema = ProviderNotificationStateSchema.pick([
  'HELD_UNCORRELATED',
  'SUBMITTED',
  'SUBMISSION_HELD',
  'SUBMISSION_DENIED',
]);

const ProviderRefsJsonSchema = Schema.toCodecJson(Schema.Array(ProviderObjectRefSchema));
/** The signed object of a signed event envelope (Stripe `data.object`), as the provider MAP lane routes it. */
const SignedEnvelopeSchema = Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ object: Schema.Json }) }));

const decodeUtf8 = (bytes: Uint8Array) =>
  Effect.option(
    Effect.try({
      catch: (cause) => ledgerUnavailable(`notification_body_not_utf8: ${String(cause).slice(0, 80)}`),
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    }),
  );

/**
 * Only an actionable signature-verified capture carries a signed object, re-read from its exact captured
 * body; shared-secret and lookup-required captures have none (their MAP lanes route without one).
 */
const signedObjectOf = (row: PspNotificationRecord) =>
  row.authenticity !== 'SIGNATURE_VERIFIED' || row.state === 'IGNORED'
    ? Effect.succeedNone
    : decodeUtf8(row.rawBody).pipe(
        Effect.map(Option.flatMap(Schema.decodeUnknownOption(SignedEnvelopeSchema))),
        Effect.map(Option.map((envelope) => envelope.data.object)),
      );

/** The stored notification as the worker reads it. */
const storedNotificationOf = Effect.fn('ProviderNotificationStore.storedOf')(function* storedNotificationOf(
  row: PspNotificationRecord,
) {
  const [providerRefs, signedObject] = yield* Effect.all(
    [
      Schema.decodeUnknownEffect(ProviderRefsJsonSchema)(row.providerRefs).pipe(
        Effect.mapError((failure) => ledgerUnavailable(`notification_record_invalid: ${failure._tag}`)),
      ),
      signedObjectOf(row),
    ],
    { concurrency: 1 },
  );
  return yield* Schema.decodeUnknownEffect(StoredProviderNotificationSchema)({
    bindingId: row.bindingId,
    correlatedOperationId: Option.fromUndefinedOr(row.correlatedOperationId),
    environment: row.environment,
    notificationId: row.notificationId,
    providerAccountRef: row.providerAccountRef,
    receivedAt: row.receivedAt,
    state: row.state,
    trigger: {
      actionable: row.state !== 'IGNORED',
      authenticity: row.authenticity,
      claimedStatus: Option.fromUndefinedOr(row.claimedStatus),
      deliveryIdentity: row.deliveryIdentity,
      family: row.providerFamily,
      providerEventAt: Option.fromUndefinedOr(row.providerEventAt),
      providerOccurrenceId: Option.fromUndefinedOr(row.providerOccurrenceId),
      providerRefs,
      signedObject,
      verifiedAt: row.verifiedAt,
    },
  }).pipe(Effect.mapError((failure) => ledgerUnavailable(`notification_record_invalid: ${failure._tag}`)));
});

const notificationIdOf = (notificationId: ProviderNotificationId) =>
  Schema.decodeUnknownEffect(PspNotificationIdSchema)(notificationId).pipe(
    Effect.mapError((failure) => ledgerUnavailable(`notification_id_invalid: ${failure._tag}`)),
  );

const read = Effect.fn('ProviderNotificationStore.read')(function* read(input: ReadProviderNotificationInput) {
  const notificationId = yield* notificationIdOf(input.notificationId);
  const row = yield* pspReadNotification(input.scope.routineInvoker, notificationId).pipe(
    Effect.mapError(routineUnavailable),
  );
  return yield* Option.match(row, {
    onNone: () => Effect.succeedNone,
    onSome: (value) => storedNotificationOf(value).pipe(Effect.map(Option.some)),
  });
});

/**
 * A refused transition fails with reason `notification_transition_refused:<routine reason>`; in particular
 * `notification_transition_refused:binding_mismatch` when the correlated operation is executed through
 * another binding than the one the notification was captured for (#1157).
 */
const transition = Effect.fn('ProviderNotificationStore.transition')(function* transition(
  input: TransitionProviderNotificationInput,
) {
  if (!Schema.is(ProcessingStateSchema)(input.to)) {
    return yield* Effect.fail(ledgerUnavailable('notification_transition_refused:illegal_transition'));
  }
  const notificationId = yield* notificationIdOf(input.notificationId);
  const result = yield* pspTransitionNotification(input.scope.routineInvoker, {
    correlatedOperationId: input.correlatedOperationId,
    deliveryId: input.workerContext.deliveryId,
    notificationId,
    to: input.to,
  }).pipe(Effect.mapError(routineUnavailable));
  const row = yield* Match.valueTags(result, {
    CONFLICT: ({ reason }) => Effect.fail(ledgerUnavailable(`notification_transition_refused:${reason}`)),
    NOT_FOUND: () => Effect.fail(ledgerUnavailable('notification_transition_refused:notification_unknown')),
    TRANSITIONED: ({ record }) => Effect.succeed(record),
    UNCHANGED: ({ record }) => Effect.succeed(record),
  });
  return yield* storedNotificationOf(row);
});

const providerNotificationStore: ProviderNotificationStoreContract = Object.freeze({ read, transition });

/** The store needs no service of its own: each call carries the verified worker scope. */
export const ProviderNotificationStoreLive = Layer.succeed(ProviderNotificationStore, providerNotificationStore);
