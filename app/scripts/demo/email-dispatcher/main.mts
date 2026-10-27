// Local after-commit host. Receipts/provider reads use the Shell API in every runtime;
// this loop keeps Mailpit SMTP and a loopback-only health endpoint for demo/up.sh.
import { createServer } from 'node:http';
import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Exit, Layer, Option, Ref, Schema, Scope } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Reactivity } from 'effect/unstable/reactivity';
import { dispatchEmailBatch } from '@app/email-delivery/dispatcher';
import { emailTransport } from '@app/email-delivery/transport';

const DatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* databaseConnection() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const HealthSchema = Schema.Struct({
  ok: Schema.Literal(true),
  provider: Schema.Struct({ configured: Schema.Boolean, label: Schema.OptionFromNullOr(Schema.String) }),
});
const MissingSchema = Schema.Struct({ error: Schema.Literal('not_found') });
const responseHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json' };
const waitForStop = Effect.callback((resume: (effect: Effect.Effect<void>) => void) => {
  const stop = (): void => {
    resume(Effect.void);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return Effect.sync(() => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  });
});

const main = Effect.gen(function* runLocalDispatcher() {
  const transport = yield* emailTransport;
  const port = yield* Config.Number('EMAIL_DISPATCHER_PORT').pipe(Config.withDefault(3096));
  const intervalMs = yield* Config.Number('EMAIL_DISPATCHER_INTERVAL_MS').pipe(Config.withDefault(2000));
  const databaseScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
  const healthScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
  const server = yield* NodeHttpServer.make(() => createServer(), { host: '127.0.0.1', port }).pipe(
    Scope.provide(healthScope),
  );
  yield* server
    .serve(
      HttpServerRequest.HttpServerRequest.use((request) =>
        request.method === 'GET' && request.url === '/healthz'
          ? HttpServerResponse.schemaJson(HealthSchema)(
              {
                ok: true,
                provider: {
                  configured: transport.provider.configured,
                  label: Option.fromNullishOr(transport.provider.label),
                },
              },
              { headers: responseHeaders },
            )
          : HttpServerResponse.schemaJson(MissingSchema)(
              { error: 'not_found' },
              { headers: responseHeaders, status: 404 },
            ),
      ),
    )
    .pipe(Scope.provide(healthScope));
  yield* Console.log(
    `[email] local dispatcher; ${transport.provider.label ?? 'NO provider'}; receipts at /shell-super-app-api/email/deliveries`,
  );
  // Build the database only when the first cycle starts, and retain its scope until the last cycle finishes.
  const database = yield* Effect.cached(Layer.buildWithScope(DatabaseLive, databaseScope));
  const stopping = yield* Ref.make(false);
  yield* waitForStop.pipe(
    Effect.tap(() => Ref.set(stopping, true)),
    Effect.andThen(Scope.close(healthScope, Exit.void)),
    Effect.forkScoped,
  );
  while (!(yield* Ref.get(stopping))) {
    yield* database.pipe(
      Effect.flatMap((context) => Effect.provideContext(dispatchEmailBatch, context)),
      Effect.catchCause(() => Console.error('[email] cycle failed')),
    );
    yield* Effect.sleep(intervalMs);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const exit = await Effect.runPromiseExit(
  main.pipe(Effect.tapCause(() => Console.error('[email] dispatcher failed to start'))),
);
if (Exit.isFailure(exit)) {
  process.exitCode = 1;
}
