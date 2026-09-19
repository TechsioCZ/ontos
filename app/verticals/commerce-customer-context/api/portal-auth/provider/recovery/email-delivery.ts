import { DateTime, Duration, Effect, Layer, Redacted, Schema } from 'effect';

import { withCause } from '../../problems-support.ts';
import { CommercePortalAuthRawEmailDeliveryService } from '../raw-email-delivery-service.ts';
import type { CommercePortalAuthEmailDelivery } from '../auth.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import { CommercePortalAuthEmailDeliveryService } from '../email-delivery-service.ts';
import { CommercePortalAuthProviderSubjectIdSchema } from './contracts.ts';
import { CommercePortalAuthRecoveryStoreService } from './store-service.ts';
import { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

type VerificationEmailData = Parameters<CommercePortalAuthEmailDelivery['sendVerificationEmail']>[0];
type ResetPasswordEmailData = Parameters<CommercePortalAuthEmailDelivery['sendResetPassword']>[0];

const verificationEmailDataSchema = Schema.Struct({
  email: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320)),
  providerSubjectId: CommercePortalAuthProviderSubjectIdSchema,
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const unavailable = (operation: string, cause: unknown): CommercePortalAuthRecoveryUnavailable =>
  withCause(
    new CommercePortalAuthRecoveryUnavailable({
      operation,
      reason: 'Commerce portal authentication email delivery is unavailable',
    }),
    cause,
  );

const normalizeEmail = (email: string): string => email.toLowerCase();

const expirationFrom = (now: Date): Date =>
  DateTime.toDate(
    DateTime.add(DateTime.makeUnsafe(now), {
      seconds: COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds,
    }),
  );

/**
 * Wrap the raw Better Auth callbacks at the provider boundary. Verification is recorded before
 * delivery so an accepted callback always has a digest-backed subject/email binding; reset and
 * OTP callbacks retain the exact raw callback references and never enter this ledger.
 */
export const makeCommercePortalAuthEmailDelivery = Effect.fn('CommercePortalAuthEmailDelivery.make')(
  function* makeCommercePortalAuthEmailDeliveryEffect(
    raw: CommercePortalAuthEmailDelivery,
  ): Effect.fn.Return<
    CommercePortalAuthEmailDelivery,
    CommercePortalAuthRecoveryUnavailable,
    CommercePortalAuthRecoveryStoreService
  > {
    const store = yield* CommercePortalAuthRecoveryStoreService;
    const effectContext = yield* Effect.context();
    const runWithContext = Effect.runPromiseWith(effectContext);
    const runEmailDeliveryEffect: <A, E>(effect: Effect.Effect<A, E>) => ReturnType<typeof runWithContext<A, E>> =
      runWithContext;
    const sendVerificationEmail = Effect.fnUntraced(function* sendVerificationEmailEffect(
      data: VerificationEmailData,
    ): Effect.fn.Return<void, unknown> {
      const metadata = yield* Schema.decodeEffect(verificationEmailDataSchema)({
        email: data.user.email,
        providerSubjectId: data.user.id,
        token: data.token,
      }).pipe(Effect.mapError((cause) => unavailable('verification-email-validation', cause)));
      const now = yield* DateTime.nowAsDate;
      const registered = yield* store.registerEmailVerificationToken({
        email: normalizeEmail(metadata.email),
        expiresAt: expirationFrom(now),
        providerSubjectId: metadata.providerSubjectId,
        token: Redacted.make(metadata.token),
      });
      if (!registered) {
        return yield* unavailable('verification-email-registration', 'VERIFICATION_BINDING_REJECTED');
      }
      return yield* Effect.tryPromise({
        catch: (cause) => unavailable('verification-email-delivery', cause),
        try: raw.sendVerificationEmail.bind(raw, data),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds),
          orElse: () => Effect.fail(unavailable('verification-email-delivery-timeout', 'PROVIDER_TIMEOUT')),
        }),
      );
    }, runEmailDeliveryEffect);

    /**
     * Records the issuance-time email/subject binding before delivery, exactly as verification
     * does, so reconciliation detection can later compare it against the provider's current state.
     */
    const sendResetPassword = Effect.fnUntraced(function* sendResetPasswordEffect(
      data: ResetPasswordEmailData,
    ): Effect.fn.Return<void, unknown> {
      const metadata = yield* Schema.decodeEffect(verificationEmailDataSchema)({
        email: data.user.email,
        providerSubjectId: data.user.id,
        token: data.token,
      }).pipe(Effect.mapError((cause) => unavailable('reset-password-email-validation', cause)));
      const now = yield* DateTime.nowAsDate;
      const registered = yield* store.registerPasswordResetToken({
        email: normalizeEmail(metadata.email),
        expiresAt: expirationFrom(now),
        providerSubjectId: metadata.providerSubjectId,
        token: Redacted.make(metadata.token),
      });
      if (!registered) {
        return yield* unavailable('reset-password-email-registration', 'RESET_BINDING_REJECTED');
      }
      return yield* Effect.tryPromise({
        catch: (cause) => unavailable('reset-password-email-delivery', cause),
        try: raw.sendResetPassword.bind(raw, data),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds),
          orElse: () => Effect.fail(unavailable('reset-password-email-delivery-timeout', 'PROVIDER_TIMEOUT')),
        }),
      );
    }, runEmailDeliveryEffect);

    return {
      sendOTP: raw.sendOTP,
      sendResetPassword,
      sendVerificationEmail,
    };
  },
);

export const CommercePortalAuthEmailDeliveryLive = Layer.effect(
  CommercePortalAuthEmailDeliveryService,
  Effect.gen(function* makeCommercePortalAuthEmailDeliveryLive() {
    const raw = yield* CommercePortalAuthRawEmailDeliveryService;
    return yield* makeCommercePortalAuthEmailDelivery(raw);
  }),
);
