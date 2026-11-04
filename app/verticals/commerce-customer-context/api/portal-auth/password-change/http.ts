import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { isAPIError } from 'better-auth/api';
import { DateTime, Duration, Effect, Result, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/http';

import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { CustomerOwnPasswordChangeSchemaError } from '../../../shared/portal-auth/password-change-api.ts';
import type { UpdateCustomerPassword } from '../../../shared/portal-auth/password-change-api.ts';
import { customerCredentialChangeOwnEntrypoint } from '../../../shared/portal-auth/password-change-entrypoints.ts';
import { CommercePortalAuthAudit } from '../../../src/portal-auth/audit/audit.ts';
import { authorizeCustomerProfile } from '../profile/http.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import { noStoreHeaders, requestHeaders, requireTrustedOrigin } from '../http-transport.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../rate-limit-service.ts';
import { consumeRateLimitBudget } from '../rate-limit-service.ts';
import { admitCustomerAccount, CommercePortalAuthService } from '../session/http.ts';
import {
  passwordChangeAuthentication,
  passwordChangeCurrentInvalid,
  passwordChangeForbidden,
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

const admissionProblem = (problem: { readonly status?: number }) => {
  if (problem.status === 401) {
    return passwordChangeAuthentication();
  }
  if (problem.status === 403) {
    return passwordChangeForbidden();
  }
  return passwordChangeUnavailable();
};

/**
 * Changes the password of the admitted session's own account. Better Auth verifies the current
 * password and revokes the account's other sessions; the owner only admits, authorizes, rate-limits
 * and records evidence. The new password is never logged, stored or returned.
 */
const changePassword = Effect.fn('CustomerPasswordChange.change')(function* changePasswordEffect(
  request: HttpServerRequest.HttpServerRequest,
  input: UpdateCustomerPassword,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, passwordChangeForbidden);
  const current = yield* admitCustomerAccount(request).pipe(Effect.mapError(admissionProblem));
  if (current.state !== 'authenticated') {
    return yield* Effect.fail(passwordChangeAuthentication());
  }
  yield* authorizeCustomerProfile(current.workloadPrincipal, customerCredentialChangeOwnEntrypoint).pipe(
    Effect.mapError((problem) => (problem.status === 403 ? passwordChangeForbidden() : passwordChangeUnavailable())),
  );
  const allowed = yield* consumeRateLimitBudget(
    `password-change|${current.session.providerSubjectId}`,
    passwordChangeRateLimit,
    { route: ROUTE, unavailable: passwordChangeUnavailable },
  );
  if (!allowed) {
    return yield* Effect.fail(passwordChangeRateLimited());
  }
  const audit = yield* CommercePortalAuthAudit;
  const event = {
    operation: 'customer-password-change',
    providerSubjectId: current.session.providerSubjectId,
    sessionRef: current.session.sessionRef,
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
      catch: (cause) => cause,
      try: async () =>
        await service.api.changePassword({
          body: {
            currentPassword: input.currentPassword,
            newPassword: input.newPassword,
            revokeOtherSessions: true,
          },
          headers: requestHeaders(request.headers),
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: providerTimeout,
        orElse: () => Effect.fail(new PasswordChangeProviderTimeout()),
      }),
    ),
  );
  if (Result.isFailure(attempt)) {
    const failure = classifyPasswordChangeFailure(attempt.failure);
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
  return { outcome: 'PASSWORD_CHANGED' as const };
});

const schemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(CustomerOwnPasswordChangeSchemaError, () =>
  Effect.fail(passwordChangeInvalid()),
);
export const customerOwnPasswordChangeApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'customerOwnPasswordChange',
  (handlers) => handlers.handle('execute', ({ payload, request }) => changePassword(request, payload)),
).pipe(Layer.provide(schemaErrorLive));
