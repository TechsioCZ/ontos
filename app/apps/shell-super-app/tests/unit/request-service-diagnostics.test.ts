// @rstest-environment node
import { createHttpApiHandler, dispatchEffectBffRequest, HttpApi } from '@modern-js/bff-effect/effect-edge';
import { Cause, Context, Effect, Exit, Layer, Logger, Option } from 'effect';
import { HttpRouter } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { logRequestServicesFailure } from '../../api/request-service-diagnostics.ts';

class RequestServicesFixture extends Context.Service<RequestServicesFixture, { readonly initialized: true }>()(
  'RequestServicesFixture',
) {}

interface CyclicDefect {
  readonly _tag: string;
  cause?: CyclicDefect;
}

const capturedLoggerLayer = (entries: string[]) =>
  Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);

const privateValue = ['credential', 'sentinel', 'not-for-logs'].join('-');

const failure = {
  _tag: 'AuthDatabaseConnectionError',
  cause: {
    _tag: 'DatabaseConfigError',
    cause: new Error(privateValue),
    connectionString: privateValue,
    reason: `The GATEWAY_ISSUER_HYPERDRIVE Worker binding is invalid: ${privateValue}`,
  },
  reason: privateValue,
};

describe('Shell request service initialization diagnostics', () => {
  it.effect('logs once before orDie and preserves the outer sanitized BFF response', () =>
    Effect.gen(function* requestServicesFailure() {
      const entries: string[] = [];
      const services = Layer.effect(RequestServicesFixture, Effect.fail(failure)).pipe(
        Layer.tapCause((cause) => logRequestServicesFailure(cause).pipe(Effect.provide(capturedLoggerLayer(entries)))),
        Layer.orDie,
      );
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createHttpApiHandler({
            api: HttpApi.make('ShellInitializationDiagnostics'),
            layer: HttpRouter.layer,
            services,
            servicesLifetime: 'request',
          }),
        ),
        (handler) => Effect.promise(handler.dispose.bind(handler)),
      );
      const response = yield* Effect.tryPromise(() =>
        dispatchEffectBffRequest(
          (request) => runtime.handler(request),
          new Request('https://shell.example.test/shell-super-app-api/oauth/.well-known/oauth-authorization-server'),
          { prefix: '/shell-super-app-api' },
        ),
      );
      const body = yield* Effect.tryPromise(response.text.bind(response));
      expect(response.status).toBe(500);
      expect(body).toBe(
        '{"success":false,"error":{"code":"INTERNAL_SERVER_ERROR","message":"Internal Server Error","status":500}}',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain('Shell request services initialization failed');
      expect(entries[0]).toContain('"initializationBoundary":"shell.requestServices"');
      expect(entries[0]).toContain('"errorTags":"AuthDatabaseConnectionError,DatabaseConfigError"');
      expect(entries[0]).toContain('"configKeys":"GATEWAY_ISSUER_HYPERDRIVE"');
      expect(entries[0]).toContain('"failureKinds":"failure"');
      expect(`${entries.join('')}${body}`).not.toContain(privateValue);
      expect(entries[0]).not.toContain('connectionString');
    }).pipe(Effect.scoped),
  );

  it.effect('preserves typed failures and reports only allow-listed labels from cyclic defects without getters', () =>
    Effect.gen(function* safeFailureEvidence() {
      const entries: string[] = [];
      let getterCalls = 0;
      const defect: CyclicDefect = { _tag: privateValue };
      defect.cause = defect;
      Object.defineProperty(defect, 'message', {
        get: () => {
          getterCalls += 1;
          return privateValue;
        },
      });
      const original = Cause.combine(Cause.fail(failure), Cause.die(defect));
      const getterCallsBeforeDiagnostic = getterCalls;
      const exit = yield* Effect.exit(
        Effect.scoped(
          Layer.build(
            Layer.effectDiscard(Effect.failCause(original)).pipe(
              Layer.tapCause((cause) =>
                logRequestServicesFailure(cause).pipe(Effect.provide(capturedLoggerLayer(entries))),
              ),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toEqual(Option.some(failure));
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain('"failureKinds":"defect,failure"');
      expect(entries[0]).not.toContain(privateValue);
      expect(getterCalls).toBe(getterCallsBeforeDiagnostic);
    }),
  );

  it.effect('does not log successful initialization', () =>
    Effect.gen(function* successfulServices() {
      const entries: string[] = [];
      yield* Effect.scoped(
        Layer.build(
          Layer.empty.pipe(
            Layer.tapCause((cause) =>
              logRequestServicesFailure(cause).pipe(Effect.provide(capturedLoggerLayer(entries))),
            ),
          ),
        ),
      );
      expect(entries).toEqual([]);
    }),
  );
});
