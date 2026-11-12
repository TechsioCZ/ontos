import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Option, Redacted, Schema } from 'effect';
import type { DateTime } from 'effect';

import { GatewayNotificationRejected } from '../psp/psp-errors.ts';
import type {
  GatewayNotificationRejectedError,
  GatewayNotificationRejectionReason,
  GatewayProviderUnavailableError,
} from '../psp/psp-errors.ts';
import type { RawProviderNotification, VerifiedNotificationTrigger } from '../psp/notification-envelope.ts';
import type { GatewayExecutionTarget } from '../psp/psp-request.ts';
import { comgateBindingOf } from './comgate-evidence.ts';
import { ComgatePaymentStatusSchema, ComgatePushSchema } from './comgate-wire.ts';
import type { ComgatePaymentStatus, ComgatePush } from './comgate-wire.ts';

/**
 * Comgate push verification (#1157), per https://apidoc.comgate.cz/en/push-notifikace and
 * https://apidoc.comgate.cz/en/zabezpeceni. A push is an HTTP POST whose body is JSON (REST v2
 * payments) or `application/x-www-form-urlencoded` (v1 payments) and carries the shop `secret` in plain
 * text; there is no signature. Verification:
 * 1. the content type (parameters such as `; charset=UTF-8` tolerated) selects the decoder; anything
 *    else, invalid UTF-8, duplicate form keys or a missing field is MALFORMED;
 * 2. `secret` equals the binding's credential, compared over the full length (SECRET_MISMATCH);
 * 3. `merchant` equals the binding's merchant id (MERCHANT_MISMATCH);
 * 4. `test` matches the binding environment and the environment the push was addressed to
 *    (ENVIRONMENT_MISMATCH).
 * The trigger is SHARED_SECRET_VERIFIED but never proves a fact: the status is always re-read through
 * lookup, the lookup wins, and a pushed status different from the lookup is recorded (claimedStatus)
 * and never rejected (donor gap C-6). The secret never leaves this module; `signedObject` is None so
 * no body (which contains the secret) is stored.
 */

const FAMILY = 'COMGATE';

const rejected = (reason: GatewayNotificationRejectionReason): GatewayNotificationRejectedError =>
  new GatewayNotificationRejected({ code: 'gateway_notification_rejected', family: FAMILY, reason });

/** The media type without parameters, lower-cased (`Application/JSON; charset=utf-8` -> `application/json`). */
const mediaTypeOf = (contentType: string): string => {
  const separator = contentType.indexOf(';');
  return (separator === -1 ? contentType : contentType.slice(0, separator)).trim().toLowerCase();
};

/**
 * Strict UTF-8: the non-fatal decode keeps a BOM and replaces invalid sequences, so the text re-encodes
 * to the exact bytes only when the body was valid UTF-8.
 */
const decodeUtf8 = (bytes: Uint8Array): Option.Option<string> => {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const reencoded = utf8ToBytes(text);
  return reencoded.length === bytes.length && reencoded.every((byte, index) => byte === bytes[index])
    ? Option.some(text)
    : Option.none();
};

const ComgatePushFromJsonSchema = Schema.fromJsonString(ComgatePushSchema);

const decodeForm = (text: string): Option.Option<ComgatePush> => {
  const params = new URLSearchParams(text);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(ComgatePushSchema)(Object.fromEntries(params));
};

const decodeByMediaType = (mediaType: string, text: string): Option.Option<ComgatePush> => {
  if (mediaType === 'application/json') {
    return Schema.decodeUnknownOption(ComgatePushFromJsonSchema)(text);
  }
  if (mediaType === 'application/x-www-form-urlencoded') {
    return decodeForm(text);
  }
  return Option.none();
};

/** Decodes the push body by its content type. Never logs or returns the body; the secret stays Redacted. */
export const decodeComgatePush = (
  notification: RawProviderNotification,
): Effect.Effect<ComgatePush, GatewayNotificationRejectedError> => {
  const text = decodeUtf8(notification.rawBody);
  const decoded = notification.headers.contentType.pipe(
    Option.flatMap((contentType) =>
      text.pipe(Option.flatMap((body) => decodeByMediaType(mediaTypeOf(contentType), body))),
    ),
  );
  return Effect.fromOption(decoded).pipe(
    Effect.catchTag('NoSuchElementError', () => Effect.fail(rejected('MALFORMED'))),
  );
};

/**
 * Compares the full length of the expected secret and never returns at the first differing byte, so
 * the position of a mismatch does not change how long the comparison runs. A length difference is a
 * mismatch. Plain JavaScript cannot guarantee constant-time execution; this avoids the obvious leak.
 */
const sameSecret = (presented: Uint8Array, expected: Uint8Array): boolean => {
  let mismatch = presented.length !== expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    if (presented[index % Math.max(presented.length, 1)] !== expected[index]) {
      mismatch = true;
    }
  }
  return !mismatch;
};

export interface VerifyComgatePushInput {
  readonly notification: RawProviderNotification;
  /** The binding's current COMGATE credential secret. */
  readonly secret: Redacted.Redacted;
  readonly target: GatewayExecutionTarget;
  /** Effect clock instant of verification (the adapter reads it). */
  readonly verifiedAt: DateTime.Utc;
}

export const verifyComgatePush: (
  input: VerifyComgatePushInput,
) => Effect.Effect<VerifiedNotificationTrigger, GatewayNotificationRejectedError | GatewayProviderUnavailableError> =
  Effect.fn('ComgatePush.verifyComgatePush')(function* verifyPush(input: VerifyComgatePushInput) {
    const { notification } = input;
    if (notification.family !== FAMILY) {
      return yield* Effect.fail(rejected('MALFORMED'));
    }
    const [binding, push] = yield* Effect.all([comgateBindingOf(input.target), decodeComgatePush(notification)], {
      concurrency: 1,
    });

    if (!sameSecret(utf8ToBytes(Redacted.value(push.secret)), utf8ToBytes(Redacted.value(input.secret)))) {
      return yield* Effect.fail(rejected('SECRET_MISMATCH'));
    }
    if (push.merchant !== binding.merchantId) {
      return yield* Effect.fail(rejected('MERCHANT_MISMATCH'));
    }
    const addressedTest = notification.environment === 'SANDBOX';
    if (push.test !== binding.test || addressedTest !== binding.test) {
      return yield* Effect.fail(rejected('ENVIRONMENT_MISMATCH'));
    }

    return {
      actionable: true,
      authenticity: 'SHARED_SECRET_VERIFIED',
      claimedStatus: Option.some(push.status),
      deliveryIdentity: `comgate:${push.transId}:${push.status}`,
      family: FAMILY,
      providerEventAt: Option.none(),
      providerOccurrenceId: Option.none(),
      providerRefs: [{ _tag: 'COMGATE_TRANSACTION', transId: push.transId }],
      signedObject: Option.none(),
      verifiedAt: input.verifiedAt,
    } satisfies VerifiedNotificationTrigger;
  });

/**
 * How a pushed status relates to the lookup that followed it. The lookup always wins: evidence comes
 * only from `mapComgateStatus`. DIFFERS is recorded for audit (e.g. pushed PAID, looked-up CANCELLED,
 * or a legitimate later transition) and is never a rejection. UNCONFIRMED: the lookup proved no status.
 */
export const ComgatePushedStatusComparisonSchema = Schema.Union([
  Schema.TaggedStruct('AGREES', { status: ComgatePaymentStatusSchema }),
  Schema.TaggedStruct('DIFFERS', { lookup: ComgatePaymentStatusSchema, pushed: Schema.Option(Schema.String) }),
  Schema.TaggedStruct('UNCONFIRMED', { pushed: Schema.Option(Schema.String) }),
]);
export type ComgatePushedStatusComparison = typeof ComgatePushedStatusComparisonSchema.Type;

export const compareComgatePushedStatus = (input: {
  readonly claimedStatus: Option.Option<string>;
  readonly lookupStatus: Option.Option<ComgatePaymentStatus>;
}): ComgatePushedStatusComparison =>
  Option.match(input.lookupStatus, {
    onNone: (): ComgatePushedStatusComparison => ({ _tag: 'UNCONFIRMED', pushed: input.claimedStatus }),
    onSome: (lookup): ComgatePushedStatusComparison =>
      Option.contains(input.claimedStatus, lookup)
        ? { _tag: 'AGREES', status: lookup }
        : { _tag: 'DIFFERS', lookup, pushed: input.claimedStatus },
  });
