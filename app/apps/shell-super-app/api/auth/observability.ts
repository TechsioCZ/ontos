import { Clock, Effect, Schema } from 'effect';

import { AuthenticationUnavailableError } from './errors.ts';
import type { AuthenticationUnavailableFailure } from './errors.ts';

/** How long one Better Auth call may run before the request fails as unavailable. */
export const AUTH_OPERATION_TIMEOUT_MS = 30_000;
// A phase that succeeds this slowly is logged too: the next hang may stop just short of the timeout.
const AUTH_PHASE_SLOW_MS = 5000;

/**
 * Where an authentication request spent its time: a Better Auth call or an OntOS resolution step.
 * Unavailable and slow phases are logged with this name, so a 503 says which step stalled.
 */
const AuthenticationPhaseSchema = Schema.Literals([
  'fixture.sign-up',
  'legal-entity-switch.validate',
  'session.legal-entities',
  'session.principal',
  'session.read',
  'session.update',
  'sign-in.credentials',
  'sign-in.principal',
  'sign-out',
  'tenant-switch.principal',
  'tenants.list',
]);
export type AuthenticationPhase = typeof AuthenticationPhaseSchema.Type;

const isAuthenticationUnavailable = Schema.is(AuthenticationUnavailableError);
const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/u;

/**
 * The id Cloudflare gives the request (`cf-ray`, also on the Workers Logs invocation), else the
 * caller's correlation id. Anything that is not a short token is dropped, so a header cannot forge
 * log lines.
 */
export const authenticationRequestId = (requestHeaders: Headers | undefined): string => {
  const candidate =
    requestHeaders?.get('cf-ray') ?? requestHeaders?.get('x-correlation-id') ?? requestHeaders?.get('x-request-id');
  if (candidate === null || candidate === undefined) {
    return 'missing';
  }
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : 'invalid';
};

const phaseAnnotations = Effect.fn('ShellAuthentication.phaseAnnotations')(function* phaseAnnotationsEffect(
  phase: AuthenticationPhase,
  requestHeaders: Headers | undefined,
  startedAt: number,
) {
  const now = yield* Clock.currentTimeMillis;
  return { authenticationPhase: phase, elapsedMs: now - startedAt, requestId: authenticationRequestId(requestHeaders) };
});

const logSlowPhase = Effect.fn('ShellAuthentication.logSlowPhase')(function* logSlowPhaseEffect(
  phase: AuthenticationPhase,
  requestHeaders: Headers | undefined,
  startedAt: number,
) {
  const annotations = yield* phaseAnnotations(phase, requestHeaders, startedAt);
  if (annotations.elapsedMs >= AUTH_PHASE_SLOW_MS) {
    yield* Effect.logWarning('Shell authentication phase was slow').pipe(Effect.annotateLogs(annotations));
  }
});

const logUnavailablePhase = Effect.fn('ShellAuthentication.logUnavailablePhase')(function* logUnavailablePhaseEffect(
  phase: AuthenticationPhase,
  requestHeaders: Headers | undefined,
  startedAt: number,
  failure: AuthenticationUnavailableFailure,
) {
  const annotations = yield* phaseAnnotations(phase, requestHeaders, startedAt);
  yield* Effect.logWarning('Shell authentication unavailable').pipe(
    Effect.annotateLogs({
      ...annotations,
      reason: failure.reason ?? 'unspecified',
      timeoutMs: AUTH_OPERATION_TIMEOUT_MS,
    }),
  );
});

/**
 * Logs an authentication phase that ends unavailable or slow, with the phase, the reason, the time
 * it took and the request id. No email, password, cookie, session or user id is logged.
 */
export const observeAuthenticationPhase =
  (phase: AuthenticationPhase, requestHeaders?: Headers) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        effect.pipe(
          Effect.tap(() => logSlowPhase(phase, requestHeaders, startedAt)),
          Effect.tapError((failure) =>
            isAuthenticationUnavailable(failure)
              ? logUnavailablePhase(phase, requestHeaders, startedAt, failure)
              : Effect.void,
          ),
        ),
      ),
    );

/** Fails a stalled Better Auth call as unavailable after the timeout and logs the phase either way. */
export const withAuthenticationTimeout =
  (phase: AuthenticationPhase, requestHeaders?: Headers) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: AUTH_OPERATION_TIMEOUT_MS,
        orElse: () => Effect.fail(new AuthenticationUnavailableError({ reason: 'timeout' })),
      }),
      observeAuthenticationPhase(phase, requestHeaders),
    );
