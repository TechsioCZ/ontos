import { isAPIError } from 'better-auth/api';
import { DateTime, Duration, Effect, Redacted, Result, Schema } from 'effect';

import { CommercePortalAuthAudit } from '../../../src/portal-auth/audit/audit.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../rate-limit-service.ts';
import { consumeRateLimitBudget } from '../rate-limit-service.ts';
import { CommercePortalAuthService } from '../session/http.ts';
import {
  passwordChangeCurrentInvalid,
  passwordChangeInvalid,
  passwordChangeRateLimited,
  passwordChangeUnavailable,
} from './problems.ts';

const ROUTE = '/change-password';
/** A stolen session may guess the current password only this often per account. */
const passwordChangeRateLimit: CommercePortalAuthRecoveryRateLimitRule = { max: 5, windowSeconds: 900 };
const providerTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds);

const CURRENT_INVALID = 'current-invalid';
const INVALID = 'invalid';
const UNAVAILABLE = 'unavailable';
export const PasswordChangeFailureClass = Schema.Literals([CURRENT_INVALID, INVALID, UNAVAILABLE]);
export type PasswordChangeFailureKind = typeof PasswordChangeFailureClass.Type;

/** The provider did not answer inside the call budget; the change is then reported as unavailable. */
class PasswordChangeProviderTimeout extends Schema.TaggedError<PasswordChangeProviderTimeout>()(
  'PasswordChangeProviderTimeout',
  {},
) {}

const WRONG_CURRENT_CODE = 'INVALID_PASSWORD';
const REJECTED_NEW_CODES = new Set(['PASSWORD_TOO_LONG', 'PASSWORD_TOO_SHORT']);

/**
 * Better Auth's own verdict on a failed `changePassword`. A wrong current password is the only
 * answer that tells the customer something; a too-short or too-long new password is a request error;
 * every other failure (including an unreachable provider) is unavailable and changes nothing.
 */
export const classifyPasswordChangeFailure = (cause: unknown): PasswordChangeFailureKind => {
  const code = isAPIError(cause) ? cause.body?.code : undefined;
  if (code === WRONG_CURRENT_CODE) {
    return CURRENT_INVALID;
  }
  if (code !== undefined && REJECTED_NEW_CODES.has(code)) {
    return INVALID;
  }
  return UNAVAILABLE;
};

/** What the routine needs of the admitted session and its request; the passwords stay redacted until Better Auth. */
export interface OwnPasswordChange {
  readonly currentPassword: Redacted.Redacted;
  readonly newPassword: Redacted.Redacted;
  readonly providerSubjectId: string;
  readonly requestHeaders: Headers;
  readonly sessionRef: string;
}

/**
 * Changes the password of the admitted session's own account. Better Auth verifies the current
 * password and revokes the account's other sessions; the owner rate-limits and records evidence. The
 * passwords are never logged, stored or returned: the portal audit records the operation, the session
 * and the outcome only.
 */
export const changeOwnPassword = Effect.fn('CustomerPasswordChange.change')(function* changeOwnPassword(
  change: OwnPasswordChange,
) {
  const allowed = yield* consumeRateLimitBudget(
    `password-change|${change.providerSubjectId}`,
    passwordChangeRateLimit,
    {
      route: ROUTE,
      unavailable: passwordChangeUnavailable,
    },
  );
  if (!allowed) {
    return yield* Effect.fail(passwordChangeRateLimited());
  }
  const audit = yield* CommercePortalAuthAudit;
  const event = {
    operation: 'customer-password-change',
    providerSubjectId: change.providerSubjectId,
    sessionRef: change.sessionRef,
  };
  // The intent row is strict: no password is changed unless the attempt is evidenced first.
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.password-change-requested.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'requested',
    })
    .pipe(Effect.mapError(passwordChangeUnavailable));
  const service = yield* CommercePortalAuthService;
  const attempt = yield* Effect.result(
    Effect.tryPromise({
      catch: classifyPasswordChangeFailure,
      try: service.api.changePassword.bind(service.api, {
        body: {
          currentPassword: Redacted.value(change.currentPassword),
          newPassword: Redacted.value(change.newPassword),
          revokeOtherSessions: true,
        },
        headers: change.requestHeaders,
      }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: providerTimeout,
        orElse: () => Effect.fail(new PasswordChangeProviderTimeout()),
      }),
    ),
  );
  if (Result.isFailure(attempt)) {
    const failure = Schema.is(PasswordChangeFailureClass)(attempt.failure) ? attempt.failure : UNAVAILABLE;
    yield* audit
      .record({
        ...event,
        eventType: 'commerce.portal-auth.password-change-failed.v1',
        occurredAt: yield* DateTime.nowAsDate,
        outcome: failure === CURRENT_INVALID ? 'authentication_failed' : 'unavailable',
      })
      .pipe(Effect.mapError(passwordChangeUnavailable));
    if (failure === CURRENT_INVALID) {
      return yield* Effect.fail(passwordChangeCurrentInvalid());
    }
    if (failure === INVALID) {
      return yield* Effect.fail(passwordChangeInvalid());
    }
    return yield* Effect.fail(passwordChangeUnavailable());
  }
  yield* audit
    .record({
      ...event,
      eventType: 'commerce.portal-auth.password-changed.v1',
      occurredAt: yield* DateTime.nowAsDate,
      outcome: 'success',
    })
    .pipe(Effect.mapError(passwordChangeUnavailable));
  return yield* Effect.void;
});
