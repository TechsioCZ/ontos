import { Effect, Exit, Fiber, Logger } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { AuthenticationUnavailableError } from '../../api/auth/errors.ts';
import {
  AUTH_OPERATION_TIMEOUT_MS,
  authenticationRequestId,
  observeAuthenticationPhase,
  withAuthenticationTimeout,
} from '../../api/auth/observability.ts';

const credentials = { email: 'person@example.test', password: 'correct horse battery staple' };

const capturedLoggerLayer = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

describe('Shell authentication observability', () => {
  it.effect('logs a stalled sign-in as a timeout with its phase and request id, and no credentials', () => {
    const entries: string[] = [];
    return Effect.gen(function* stalledSignIn() {
      const signIn = yield* Effect.never.pipe(
        withAuthenticationTimeout(
          'sign-in.credentials',
          new Headers({ 'cf-ray': '8f1c2d3e4a5b6c7d-PRG', cookie: 'better-auth.session_token=secret' }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(AUTH_OPERATION_TIMEOUT_MS);
      const exit = yield* Fiber.await(signIn);

      expect(exit).toStrictEqual(Exit.fail(new AuthenticationUnavailableError({ reason: 'timeout' })));
      expect(entries).toHaveLength(1);
      const [entry = ''] = entries;
      expect(JSON.parse(entry)).toMatchObject({
        annotations: {
          authenticationPhase: 'sign-in.credentials',
          elapsedMs: AUTH_OPERATION_TIMEOUT_MS,
          reason: 'timeout',
          requestId: '8f1c2d3e4a5b6c7d-PRG',
          timeoutMs: AUTH_OPERATION_TIMEOUT_MS,
        },
        level: 'WARN',
        message: 'Shell authentication unavailable',
      });
      expect(entry).not.toContain(credentials.email);
      expect(entry).not.toContain(credentials.password);
      expect(entry).not.toContain('secret');
    }).pipe(Effect.provide(capturedLoggerLayer(entries)));
  });

  it.effect('logs the reason of an unavailable phase that fails before the timeout', () => {
    const entries: string[] = [];
    return Effect.gen(function* unavailableResolver() {
      const exit = yield* Effect.fail(
        new AuthenticationUnavailableError({ reason: 'principal_resolver_unavailable' }),
      ).pipe(
        observeAuthenticationPhase('session.principal', new Headers({ 'x-correlation-id': 'corr-123' })),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(entries.map((entry) => JSON.parse(entry))).toMatchObject([
        {
          annotations: {
            authenticationPhase: 'session.principal',
            elapsedMs: 0,
            reason: 'principal_resolver_unavailable',
            requestId: 'corr-123',
          },
          message: 'Shell authentication unavailable',
        },
      ]);
    }).pipe(Effect.provide(capturedLoggerLayer(entries)));
  });

  it.effect('logs a slow phase that still succeeds and stays quiet for a fast one', () => {
    const entries: string[] = [];
    return Effect.gen(function* slowAndFastPhases() {
      yield* Effect.succeed('fast').pipe(observeAuthenticationPhase('session.read'));
      const slow = yield* Effect.sleep('6 seconds').pipe(observeAuthenticationPhase('session.read'), Effect.forkChild);
      yield* TestClock.adjust('6 seconds');
      yield* Fiber.join(slow);

      expect(entries.map((entry) => JSON.parse(entry))).toMatchObject([
        {
          annotations: { authenticationPhase: 'session.read', elapsedMs: 6000, requestId: 'missing' },
          message: 'Shell authentication phase was slow',
        },
      ]);
    }).pipe(Effect.provide(capturedLoggerLayer(entries)));
  });

  it('keeps only short request ids so a header cannot forge log lines', () => {
    expect(authenticationRequestId(new Headers({ 'x-request-id': 'abc_DEF-123' }))).toBe('abc_DEF-123');
    expect(authenticationRequestId(new Headers({ 'x-request-id': 'bad id level=ERROR' }))).toBe('invalid');
    expect(authenticationRequestId(new Headers({ 'x-request-id': 'a'.repeat(65) }))).toBe('invalid');
    expect(authenticationRequestId(new Headers())).toBe('missing');
  });
});
