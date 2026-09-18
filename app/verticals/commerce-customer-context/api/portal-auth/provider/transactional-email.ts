import { EmailDeliveryService } from '@app/email-delivery/server';
import { Effect, Layer, Redacted } from 'effect';

import type { CommercePortalAuthEmailDelivery } from './auth.ts';
import { CommercePortalAuthRawEmailDeliveryService } from './raw-email-delivery-service.ts';

/** Commerce owns authentication content; the installed delivery service owns transport. */
export const makeCommercePortalAuthTransactionalEmail = Effect.fn('CommercePortalAuthTransactionalEmail.make')(
  function* makeCommercePortalAuthTransactionalEmailEffect() {
    const delivery = yield* EmailDeliveryService;
    const context = yield* Effect.context();
    const runWithContext = Effect.runPromiseWith(context);
    const run: <A, E>(effect: Effect.Effect<A, E>) => ReturnType<typeof runWithContext<A, E>> = runWithContext;
    const sendVerificationEmail = Effect.fnUntraced(function* sendVerificationEmailEffect(
      data: Parameters<CommercePortalAuthEmailDelivery['sendVerificationEmail']>[0],
    ) {
      yield* delivery.send({
        subject: 'Verify your OntOS Commerce email address',
        text: Redacted.make(
          `Verify your email address using this link:\n\n${data.url}\n\nIf you did not request this, you can ignore this email.`,
        ),
        to: data.user.email,
      });
    }, run);
    const sendResetPassword = Effect.fnUntraced(function* sendResetPasswordEffect(
      data: Parameters<CommercePortalAuthEmailDelivery['sendResetPassword']>[0],
    ) {
      yield* delivery.send({
        subject: 'Reset your OntOS Commerce password',
        text: Redacted.make(
          `Reset your password using this link:\n\n${data.url}\n\nIf you did not request this, you can ignore this email.`,
        ),
        to: data.user.email,
      });
    }, run);
    const sendOTP = Effect.fnUntraced(function* sendOTPEffect(
      data: Parameters<CommercePortalAuthEmailDelivery['sendOTP']>[0],
    ) {
      yield* delivery.send({
        subject: 'Your OntOS Commerce verification code',
        text: Redacted.make(
          `Your verification code is:\n\n${data.otp}\n\nDo not share this code. If you did not request it, you can ignore this email.`,
        ),
        to: data.user.email,
      });
    }, run);
    return { sendOTP, sendResetPassword, sendVerificationEmail } satisfies CommercePortalAuthEmailDelivery;
  },
);

export const CommercePortalAuthTransactionalEmailLive = Layer.effect(
  CommercePortalAuthRawEmailDeliveryService,
  makeCommercePortalAuthTransactionalEmail(),
);
