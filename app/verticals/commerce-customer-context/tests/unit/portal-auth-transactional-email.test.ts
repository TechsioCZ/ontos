import { EmailDeliveryAcceptanceIndeterminate, EmailDeliveryService } from '@app/email-delivery/server';
import type { EmailDeliveryMessage, EmailDeliveryServiceContract } from '@app/email-delivery/server';
import { Effect, Redacted, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCommercePortalAuthTransactionalEmail } from '../../api/portal-auth/provider/transactional-email.ts';
import type { CommercePortalAuthEmailDelivery } from '../../api/portal-auth/provider/auth.ts';

const owner = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  email: 'commerce-owner@example.test',
  emailVerified: false,
  id: 'commerce-owner-1',
  image: null,
  name: 'Commerce Owner',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const verificationEmailData = {
  token: 'verification-token-opaque',
  url: 'https://portal.example.test/verify-email?token=verification-token-opaque',
  user: owner,
} satisfies Parameters<CommercePortalAuthEmailDelivery['sendVerificationEmail']>[0];

const resetPasswordData = {
  token: 'reset-token-opaque',
  url: 'https://portal.example.test/reset-password?token=reset-token-opaque',
  user: owner,
} satisfies Parameters<CommercePortalAuthEmailDelivery['sendResetPassword']>[0];

const otpData = {
  otp: '731904',
  user: { ...owner, twoFactorEnabled: true },
} satisfies Parameters<CommercePortalAuthEmailDelivery['sendOTP']>[0];

const makeRecordingDelivery = (messages: EmailDeliveryMessage[]): EmailDeliveryServiceContract => ({
  send: (message) =>
    Effect.sync(() => {
      messages.push(message);
      return { accepted: true, id: `fixture-email-${messages.length}` };
    }),
});

const makeCallbacks = (delivery: EmailDeliveryServiceContract) =>
  makeCommercePortalAuthTransactionalEmail().pipe(Effect.provideService(EmailDeliveryService, delivery));

it.effect('routes Better Auth email and OTP content through the injected delivery service', () =>
  Effect.gen(function* transactionalEmailMapping() {
    const messages: EmailDeliveryMessage[] = [];
    const callbacks = yield* makeCallbacks(makeRecordingDelivery(messages));

    yield* Effect.promise(() => callbacks.sendVerificationEmail(verificationEmailData));
    yield* Effect.promise(() => callbacks.sendResetPassword(resetPasswordData));
    yield* Effect.promise(() => callbacks.sendOTP(otpData));

    expect(messages.map(({ subject, text, to }) => ({ subject, text: Redacted.value(text), to }))).toStrictEqual([
      {
        subject: 'Verify your OntOS Commerce email address',
        text: 'Verify your email address using this link:\n\nhttps://portal.example.test/verify-email?token=verification-token-opaque\n\nIf you did not request this, you can ignore this email.',
        to: owner.email,
      },
      {
        subject: 'Reset your OntOS Commerce password',
        text: 'Reset your password using this link:\n\nhttps://portal.example.test/reset-password?token=reset-token-opaque\n\nIf you did not request this, you can ignore this email.',
        to: owner.email,
      },
      {
        subject: 'Your OntOS Commerce verification code',
        text: 'Your verification code is:\n\n731904\n\nDo not share this code. If you did not request it, you can ignore this email.',
        to: owner.email,
      },
    ]);
    expect(messages.map((message) => Object.keys(message))).toStrictEqual([
      ['subject', 'text', 'to'],
      ['subject', 'text', 'to'],
      ['subject', 'text', 'to'],
    ]);
  }),
);

it.effect('propagates injected delivery failure through the Better Auth Promise callback boundary', () => {
  const deliveryFailure = new EmailDeliveryAcceptanceIndeterminate({ reason: 'transport' });
  const messages: EmailDeliveryMessage[] = [];
  const delivery: EmailDeliveryServiceContract = {
    send: (message) => {
      messages.push(message);
      return Effect.fail(deliveryFailure);
    },
  };

  return Effect.gen(function* transactionalEmailFailure() {
    const callbacks = yield* makeCallbacks(delivery);
    const result = yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () => callbacks.sendVerificationEmail(verificationEmailData),
    }).pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBe(deliveryFailure);
    }
    expect(messages).toHaveLength(1);
  });
});
