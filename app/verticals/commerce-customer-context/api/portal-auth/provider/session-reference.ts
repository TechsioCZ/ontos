import { Effect, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../../shared/portal-auth-contracts.ts';

export class CommercePortalAuthSessionReferenceError extends Schema.TaggedError<CommercePortalAuthSessionReferenceError>()(
  'CommercePortalAuthSessionReferenceError',
  {
    reason: Schema.String,
  },
) {}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const SESSION_REFERENCE_PREFIX = `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:`;

/** Convert only a Better Auth session.id into the namespaced reference accepted by Core. */
export const encodeCommerceSessionReference = (
  sessionId: string,
): Effect.Effect<string, CommercePortalAuthSessionReferenceError> => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return Effect.fail(
      new CommercePortalAuthSessionReferenceError({
        reason: 'Better Auth session id is not a safe bounded reference',
      }),
    );
  }
  return Schema.decodeEffect(CommerceSessionReferenceSchema)(`${SESSION_REFERENCE_PREFIX}${sessionId}`).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new CommercePortalAuthSessionReferenceError({
          reason: 'Commerce session reference failed its namespace validation',
        }),
        'cause',
        { configurable: true, value: cause },
      ),
    ),
  );
};

/** Parse a Core reference back to the provider-owned session.id; never accept a session token. */
export const parseCommerceSessionReference = (
  reference: string,
): Effect.Effect<string, CommercePortalAuthSessionReferenceError> =>
  Schema.decodeEffect(CommerceSessionReferenceSchema)(reference).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(
        new CommercePortalAuthSessionReferenceError({
          reason: 'Commerce session reference is malformed or from another namespace',
        }),
        'cause',
        { configurable: true, value: cause },
      ),
    ),
    Effect.flatMap((decoded) => {
      const sessionId = decoded.slice(SESSION_REFERENCE_PREFIX.length);
      return SESSION_ID_PATTERN.test(sessionId)
        ? Effect.succeed(sessionId)
        : Effect.fail(
            new CommercePortalAuthSessionReferenceError({
              reason: 'Commerce session id is not a safe bounded reference',
            }),
          );
    }),
  );

export const commerceSessionReferencePrefix = SESSION_REFERENCE_PREFIX;
