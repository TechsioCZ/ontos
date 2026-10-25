import { randomBytes } from 'node:crypto';

import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
  isPostgresUniqueViolation,
  PersonInvitationIdentityProvider,
} from '@app/core-runtime';
import type { PersonInvitationIdentityInput, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Layer, Schema } from 'effect';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';

import { user, verification } from './schema.ts';

// Better Auth's native sign-in uses z.email(): reject identifiers it cannot later authenticate.
const LoginEmailSchema = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(
    /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u,
  ),
);
const emailConstraints = new Set(['user_email_unique']);
const providerFailure = (cause: EffectDrizzleQueryError) => {
  if (isPostgresUniqueViolation(cause, emailConstraints)) {
    return new IdentityLifecycleConflictError({
      code: 'identity_lifecycle_conflict',
      reason: 'A login with this e-mail already exists',
    });
  }
  return Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'The invited login could not be provisioned',
    }),
    'cause',
    { value: cause },
  );
};

/** Only the owning Action factory receives this capability; no pool, HTTP or mail is involved. */
export const personInvitationIdentityFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  provision: Effect.fn('PersonInvitationIdentity.provision')(function* provision(input: PersonInvitationIdentityInput) {
    yield* Schema.decodeEffect(LoginEmailSchema)(input.email).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new IdentityTargetInvalidError({
            code: 'identity_target_invalid',
            reason: 'The invitation e-mail must be a valid login address',
          }),
          'cause',
          { value: cause },
        ),
      ),
    );
    const token = yield* Effect.sync(() => randomBytes(32).toString('base64url'));
    yield* transaction
      .insert(user)
      .values({
        email: input.email,
        emailVerified: false,
        id: input.providerSubjectId,
        name: input.displayName,
      })
      .pipe(Effect.mapError(providerFailure));
    // The native reset-password endpoint consumes this exact verification atomically with its credential write.
    // No credential account exists until acceptance. The token never enters Core Action results/audit/outbox.
    yield* transaction
      .insert(verification)
      .values({
        expiresAt: input.expiresAt,
        id: input.verificationId,
        identifier: `reset-password:${token}`,
        value: input.providerSubjectId,
      })
      .pipe(Effect.mapError(providerFailure));
  }),
});

export const BetterAuthPersonInvitationIdentityProviderLive = Layer.succeed(PersonInvitationIdentityProvider, {
  fromTransaction: personInvitationIdentityFromTransaction,
});
