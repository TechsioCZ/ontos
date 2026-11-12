import { DateTime, Effect, Option } from 'effect';

import { DELIVERY_IDENTITY_MAX_LENGTH } from '../psp/notification-envelope.ts';
import type { RawProviderNotification, VerifiedNotificationTrigger } from '../psp/notification-envelope.ts';
import { GatewayNotificationRejected } from '../psp/psp-errors.ts';
import type { GatewayNotificationRejectedError, GatewayNotificationRejectionReason } from '../psp/psp-errors.ts';
import type { GatewayExecutionTarget } from '../psp/psp-request.ts';
import { gopayProviderObjectId, parseGopayId } from './gopay-wire.ts';

/**
 * GoPay HTTP notification (#1157; https://doc.gopay.com/#receiving-the-http-notification). GoPay
 * sends an unsigned HTTP GET to the create-time `notification_url` with `?id=<payment id>` (and
 * `&parent_id=` only for recurring payments). It carries no state: the trigger is LOOKUP_REQUIRED and
 * nothing in it is evidence. Only the inquiry through the original binding decides.
 *
 * Rejections (never stored): another family or binding → BINDING_UNKNOWN; another environment →
 * ENVIRONMENT_MISMATCH; an absent or malformed `id`, a malformed `parent_id`, a non-empty body or a
 * delivery identity longer than the stored bound (an over-long relay delivery ref) → MALFORMED. A well-formed `parent_id` names a recurring payment, which OntOS never creates: the
 * trigger is stored but not actionable (IGNORED).
 */

const reject = (reason: GatewayNotificationRejectionReason): GatewayNotificationRejectedError =>
  new GatewayNotificationRejected({ code: 'gateway_notification_rejected', family: 'GOPAY', reason });

const refusal = (
  target: GatewayExecutionTarget,
  notification: RawProviderNotification,
): Option.Option<GatewayNotificationRejectionReason> => {
  if (
    notification.family !== 'GOPAY' ||
    target.binding.providerFamily !== 'GOPAY' ||
    target.binding.providerAccountRef !== notification.providerAccountRef
  ) {
    return Option.some('BINDING_UNKNOWN');
  }
  if (target.binding.environment !== notification.environment) {
    return Option.some('ENVIRONMENT_MISMATCH');
  }
  if (notification.rawBody.length > 0) {
    return Option.some('MALFORMED');
  }
  return Option.none();
};

/** Verifies a GoPay callback for the binding it was addressed to; `verifiedAt` comes from the Effect clock. */
export const verifyGopayNotification = Effect.fn('GopayNotification.verifyGopayNotification')(
  function* verifyGopayNotificationEffect(target: GatewayExecutionTarget, notification: RawProviderNotification) {
    const refused = refusal(target, notification);
    if (Option.isSome(refused)) {
      return yield* Effect.fail(reject(refused.value));
    }
    const paymentId = notification.query.paymentRef.pipe(Option.flatMap(parseGopayId));
    if (Option.isNone(paymentId)) {
      return yield* Effect.fail(reject('MALFORMED'));
    }
    const recurring = Option.isSome(notification.query.parentPaymentRef);
    if (recurring && Option.isNone(notification.query.parentPaymentRef.pipe(Option.flatMap(parseGopayId)))) {
      return yield* Effect.fail(reject('MALFORMED'));
    }
    const paymentRef = gopayProviderObjectId(paymentId.value);
    const deliveryIdentity = `gopay:${paymentRef}:${notification.transportDeliveryRef}`;
    if (deliveryIdentity.length > DELIVERY_IDENTITY_MAX_LENGTH) {
      return yield* Effect.fail(reject('MALFORMED'));
    }
    const verifiedAt = yield* DateTime.now;
    const trigger: VerifiedNotificationTrigger = {
      actionable: !recurring,
      authenticity: 'LOOKUP_REQUIRED',
      claimedStatus: Option.none(),
      deliveryIdentity,
      family: 'GOPAY',
      providerEventAt: Option.none(),
      providerOccurrenceId: Option.none(),
      providerRefs: [{ _tag: 'GOPAY_PAYMENT', id: paymentRef }],
      signedObject: Option.none(),
      verifiedAt,
    };
    return trigger;
  },
);
