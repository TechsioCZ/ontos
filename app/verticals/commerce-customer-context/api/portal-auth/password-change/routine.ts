import { isAPIError } from 'better-auth/api';
import { Duration, Effect, Fiber, Option, Redacted, Result, Schema, Semaphore } from 'effect';

import { CommercePortalAuthAudit } from '../../../src/portal-auth/audit/audit.ts';
import type {
  CommercePortalAuthAuditEventType,
  CommercePortalAuthAuditOutcome,
} from '../../../src/portal-auth/audit/audit-contracts.ts';
import { recordOwnPortalRow } from '../../../src/portal-auth/audit/own-portal-outcome.ts';
import type { OwnPortalAuditSubject } from '../../../src/portal-auth/audit/own-portal-outcome.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../rate-limit-service.ts';
import { consumeRateLimitBudget } from '../rate-limit-service.ts';
import { CommercePortalAuthService } from '../session/auth-service.ts';
import { outcomeUnknownLanguageOf } from './outcome-unknown-texts.ts';
import {
  passwordChangeCurrentInvalid,
  passwordChangeInvalid,
  passwordChangeOutcomeUnknown,
  passwordChangeRateLimited,
  passwordChangeUnavailable,
} from './problems.ts';

const ROUTE = '/change-password';
/** A stolen session may guess the current password only this often per account. */
const passwordChangeRateLimit: CommercePortalAuthRecoveryRateLimitRule = { max: 5, windowSeconds: 900 };
const providerTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds);
/** How long a late provider verdict is still awaited after the customer was told the change may still complete. */
const lateVerdictBudget = Duration.minutes(5);
/**
 * Password changes running against the provider at once in this process, those whose requester stopped waiting
 * included: a timed-out change keeps its provider call alive up to the late-verdict budget, so the cap bounds what a
 * burst of timeouts can leave running. Past it a change is refused as unavailable before any provider call.
 */
const PASSWORD_CHANGES_IN_FLIGHT = 32;
const passwordChangesInFlight = Semaphore.makeUnsafe(PASSWORD_CHANGES_IN_FLIGHT);

const FAILED = 'commerce.portal-auth.password-change-failed.v1';
const CURRENT_INVALID = 'current-invalid';
const INVALID = 'invalid';
const UNAVAILABLE = 'unavailable';
export const PasswordChangeFailureClass = Schema.Literals([CURRENT_INVALID, INVALID, UNAVAILABLE]);
export type PasswordChangeFailureKind = typeof PasswordChangeFailureClass.Type;

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
  /** The Core invocation whose committed authorization admitted this change; every portal row carries it. */
  readonly actionInvocationId: string;
  readonly currentPassword: Redacted.Redacted;
  readonly newPassword: Redacted.Redacted;
  readonly providerSubjectId: string;
  readonly requestHeaders: Headers;
  readonly sessionRef: string;
}

/** The provider's verdict on the change, as a value: it settles on its own fiber, whoever is still waiting. */
type ProviderVerdict = Result.Result<unknown, PasswordChangeFailureKind>;

const failureOutcomeOf = (failure: PasswordChangeFailureKind) =>
  failure === CURRENT_INVALID ? ('authentication_failed' as const) : ('unavailable' as const);

/**
 * Changes the password of the admitted session's own account. Better Auth verifies the current password and revokes
 * the account's other sessions; the owner rate-limits and records evidence. Every attempt whose authorization
 * committed gets exactly one outcome row (changed, refused with its class, or outcome unknown), tied to the Core
 * invocation. The passwords are never logged, stored or returned, and no provider message is recorded.
 *
 * Better Auth's call cannot be cancelled, so it is never abandoned silently: past the call budget the customer is told
 * the change may still complete, the row says `outcome_unknown`, and the provider's eventual verdict is recorded when
 * it arrives, under the same invocation.
 */
export const changeOwnPassword = Effect.fn('CustomerPasswordChange.change')(function* changeOwnPassword(
  change: OwnPasswordChange,
) {
  const audit = yield* CommercePortalAuthAudit;
  const subject: OwnPortalAuditSubject = {
    actionInvocationId: change.actionInvocationId,
    operation: 'customer-password-change',
    providerSubjectId: change.providerSubjectId,
    sessionRef: change.sessionRef,
  };
  const row = (eventType: CommercePortalAuthAuditEventType, outcome: CommercePortalAuthAuditOutcome) =>
    recordOwnPortalRow(audit, subject, { eventType, outcome }).pipe(Effect.mapError(passwordChangeUnavailable));
  const allowed = yield* consumeRateLimitBudget(
    `password-change|${change.providerSubjectId}`,
    passwordChangeRateLimit,
    {
      route: ROUTE,
      unavailable: passwordChangeUnavailable,
    },
  ).pipe(Effect.tapError(() => row(FAILED, 'unavailable')));
  if (!allowed) {
    yield* row(FAILED, 'rate_limited');
    return yield* Effect.fail(passwordChangeRateLimited());
  }
  // The intent row is strict: no password is changed unless the attempt is evidenced first.
  yield* row('commerce.portal-auth.password-change-requested.v1', 'requested').pipe(
    Effect.tapError(() => row(FAILED, 'unavailable')),
  );
  const service = yield* CommercePortalAuthService;
  const call: Effect.Effect<Option.Option<ProviderVerdict>> = Effect.tryPromise({
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
    Effect.result,
    Effect.map(Option.some),
    // The verdict is awaited this long at most; past it nothing more is recorded and `outcome_unknown` stands.
    Effect.timeoutOrElse({
      duration: lateVerdictBudget,
      orElse: () => Effect.succeed(Option.none<ProviderVerdict>()),
    }),
  );
  const settle = (verdict: ProviderVerdict): Effect.Effect<void, ReturnType<typeof passwordChangeUnavailable>> =>
    Result.isSuccess(verdict)
      ? row('commerce.portal-auth.password-changed.v1', 'success')
      : row(FAILED, failureOutcomeOf(verdict.failure));
  // One permit per provider call, held until the call itself settles (a timed-out one included), never by the request.
  // Taking it and starting the call are one uninterruptible step, so no interruption can strand a permit.
  const started = yield* Effect.uninterruptible(
    Semaphore.takeIfAvailable(passwordChangesInFlight, 1).pipe(
      Effect.flatMap((taken) =>
        taken
          ? Effect.forkDetach(call.pipe(Effect.ensuring(Semaphore.release(passwordChangesInFlight, 1)))).pipe(
              Effect.map(Option.some),
            )
          : Effect.succeed(Option.none()),
      ),
    ),
  );
  if (Option.isNone(started)) {
    yield* row(FAILED, 'unavailable');
    return yield* Effect.fail(passwordChangeUnavailable());
  }
  const provider = started.value;
  const verdict = yield* Fiber.join(provider).pipe(
    Effect.timeoutOrElse({ duration: providerTimeout, orElse: () => Effect.succeed(Option.none<ProviderVerdict>()) }),
  );
  if (Option.isNone(verdict)) {
    yield* row('commerce.portal-auth.password-change-outcome-unknown.v1', 'outcome_unknown');
    // The provider's eventual verdict, recorded when it arrives under the same invocation; nobody waits for it.
    yield* Effect.forkDetach(
      Fiber.join(provider).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: settle })),
        Effect.ignore,
      ),
    );
    return yield* Effect.fail(passwordChangeOutcomeUnknown(outcomeUnknownLanguageOf(change.requestHeaders)));
  }
  yield* settle(verdict.value);
  if (Result.isFailure(verdict.value)) {
    const { failure } = verdict.value;
    if (failure === CURRENT_INVALID) {
      return yield* Effect.fail(passwordChangeCurrentInvalid());
    }
    return yield* Effect.fail(failure === INVALID ? passwordChangeInvalid() : passwordChangeUnavailable());
  }
  return yield* Effect.void;
});
