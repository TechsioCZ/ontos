import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Record, Schema } from 'effect';

import { CapturedProviderNotificationIdSchema } from '../../shared/actions/capture-provider-notification.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { GatewayProviderAccountBindingId } from '../../shared/domain/psp-configuration.ts';
import { ProviderNotificationStateSchema } from '../../shared/domain/psp-vocabulary.ts';
import { pspProviderNotifications } from '../database/schema.ts';
import type {
  RawProviderNotification,
  VerifiedNotificationCapture,
} from '../integrations/psp/notification-envelope.ts';
import { ProviderObjectRefSchema } from '../integrations/psp/psp-request.ts';

/**
 * Action-side persistence of captured provider notifications (#1157), over the Core-installed
 * `ScopedTransactionExecutor` of `capture-provider-notification`. The row carries the capture Action's
 * provenance, the allow-listed parts of the received envelope and only the body bytes its verifier declared
 * (`retainedBody`): never the received body itself, which may carry a gateway credential (#1155). Its
 * processing columns are advanced later only by the worker routines. One row per (Tenant, Selling Legal Entity, binding, delivery identity): a repeated delivery finds
 * the stored row and writes nothing.
 */

/** The two states a capture writes; the database refuses any other initial state. */
export const CapturedNotificationStateSchema = ProviderNotificationStateSchema.pick(['CAPTURED', 'IGNORED']);
export type CapturedNotificationState = typeof CapturedNotificationStateSchema.Type;

export interface CaptureProviderNotificationInput {
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly notification: RawProviderNotification;
  readonly provenance: PaymentExecutionProvenance;
  readonly state: CapturedNotificationState;
  readonly trigger: VerifiedNotificationCapture;
}

/** INSERTED: this capture stored the row. EXISTING: the delivery was already stored; nothing was written. */
export const CaptureProviderNotificationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('EXISTING', { notificationId: CapturedProviderNotificationIdSchema }),
  Schema.TaggedStruct('INSERTED', { notificationId: CapturedProviderNotificationIdSchema }),
]);
export type CaptureProviderNotificationOutcome = typeof CaptureProviderNotificationOutcomeSchema.Type;

export interface PspNotificationCapturePersistence {
  /**
   * Stores the notification unless its delivery identity is already stored for the binding in this scope.
   * A concurrent capture of the same delivery waits on the unique key and then finds the committed row.
   */
  readonly captureNotification: (
    input: CaptureProviderNotificationInput,
  ) => Effect.Effect<CaptureProviderNotificationOutcome, PaymentUnavailable>;
}

const ProviderRefsJsonSchema = Schema.toCodecJson(Schema.Array(ProviderObjectRefSchema));
const encodeProviderRefs = Schema.encodeEffect(ProviderRefsJsonSchema);
const encodeBase64 = Schema.encodeEffect(Schema.Uint8ArrayFromBase64);
const decodeOutcome = Schema.decodeUnknownEffect(CaptureProviderNotificationOutcomeSchema);

const writeFailure = (cause: unknown) => paymentUnavailable('The provider notification could not be stored', cause);
const readFailure = (cause: unknown) => paymentUnavailable('The stored provider notification could not be read', cause);
const encodeFailure = (cause: unknown) =>
  paymentUnavailable('The provider notification could not be encoded for storage', cause);

/** Only the allow-listed headers that were present, under their lower-cased HTTP names. */
const headersDocumentOf = (notification: RawProviderNotification) =>
  Record.getSomes({
    'content-type': notification.headers.contentType,
    'stripe-signature': notification.headers.stripeSignature,
  });

/** Only the allow-listed GoPay query parameters that were present, under their wire names. */
const queryDocumentOf = (notification: RawProviderNotification) =>
  Record.getSomes({ id: notification.query.paymentRef, parent_id: notification.query.parentPaymentRef });

const toDate = (instant: DateTime.Utc) => DateTime.toDateUtc(instant);

/** Construction is private to a Core-owned transaction; handlers receive only this closed method. */
export const pspNotificationCapturePersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PspNotificationCapturePersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const selectExisting = Effect.fn('PspNotificationCapturePersistence.selectExisting')(function* selectExisting(
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    input: CaptureProviderNotificationInput,
  ) {
    const [row] = yield* transaction
      .select({ notificationId: pspProviderNotifications.notificationId })
      .from(pspProviderNotifications)
      .where(
        and(
          eq(pspProviderNotifications.tenantId, scope.tenantId),
          eq(pspProviderNotifications.legalEntityId, scope.legalEntityId),
          eq(pspProviderNotifications.bindingId, input.bindingId),
          eq(pspProviderNotifications.deliveryIdentity, input.trigger.deliveryIdentity),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    if (row === undefined) {
      return yield* paymentUnavailable('The conflicting provider notification delivery is not visible');
    }
    return row.notificationId;
  });

  const captureNotification = Effect.fn('PspNotificationCapturePersistence.captureNotification')(
    function* captureNotification(input: CaptureProviderNotificationInput) {
      const scope = yield* ownerScope;
      const { notification, trigger } = input;
      const [providerRefs, retainedBodyBase64] = yield* Effect.all(
        [encodeProviderRefs(trigger.providerRefs), encodeBase64(trigger.retainedBody)],
        { concurrency: 1 },
      ).pipe(Effect.mapError(encodeFailure));
      const inserted = yield* transaction
        .insert(pspProviderNotifications)
        .values({
          actionInvocationId: input.provenance.actionInvocationId,
          actorPrincipalId: input.provenance.actorPrincipalId,
          authenticity: trigger.authenticity,
          bindingId: input.bindingId,
          claimedStatus: Option.getOrNull(trigger.claimedStatus),
          compositionRevision: input.provenance.compositionRevision,
          deliveryIdentity: trigger.deliveryIdentity,
          environment: notification.environment,
          headers: headersDocumentOf(notification),
          legalEntityId: scope.legalEntityId,
          providerAccountRef: notification.providerAccountRef,
          providerEventAt: trigger.providerEventAt.pipe(Option.map(toDate), Option.getOrNull),
          providerFamily: notification.family,
          providerOccurrenceId: Option.getOrNull(trigger.providerOccurrenceId),
          providerRefs,
          query: queryDocumentOf(notification),
          rawBody: sql`decode(${retainedBodyBase64}, 'base64')`,
          receivedAt: toDate(notification.receivedAt),
          state: input.state,
          tenantId: scope.tenantId,
          transportDeliveryRef: notification.transportDeliveryRef,
          verifiedAt: toDate(trigger.verifiedAt),
        })
        .onConflictDoNothing({
          target: [
            pspProviderNotifications.tenantId,
            pspProviderNotifications.legalEntityId,
            pspProviderNotifications.bindingId,
            pspProviderNotifications.deliveryIdentity,
          ],
        })
        .returning({ notificationId: pspProviderNotifications.notificationId })
        .pipe(Effect.mapError(writeFailure));
      const [row] = inserted;
      const outcome =
        row === undefined
          ? { _tag: 'EXISTING', notificationId: yield* selectExisting(scope, input) }
          : { _tag: 'INSERTED', notificationId: row.notificationId };
      return yield* decodeOutcome(outcome).pipe(Effect.mapError(readFailure));
    },
  );

  return Object.freeze({ captureNotification });
};
