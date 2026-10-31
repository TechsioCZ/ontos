// Local after-commit host. Receipts/provider reads use the Shell API in every runtime;
// this loop keeps Mailpit SMTP and a loopback-only health endpoint for demo/up.sh.
import { createServer } from 'node:http';
import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Exit, Layer, Option, Ref, Schema, Scope } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { dispatchEmailBatch } from '@app/email-delivery/dispatcher';
import { emailTransport } from '@app/email-delivery/transport';

const healthSchema = Schema.Struct({
  ok: Schema.Literal(true),
  provider: Schema.Struct({ configured: Schema.Boolean, label: Schema.OptionFromNullOr(Schema.String) }),
});
const notFoundSchema = Schema.Struct({ error: Schema.Literal('not_found') });
const responseHeaders = { 'cache-control': 'no-store' };

export const healthResponse = Effect.gen(function* healthResponse() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method === 'GET' && request.url === '/healthz') {
    const transport = yield* emailTransport;
    return yield* HttpServerResponse.schemaJson(healthSchema)(
      { ok: true, provider: { ...transport.provider, label: Option.fromNullOr(transport.provider.label) } },
      { headers: responseHeaders },
    );
  }
  return yield* HttpServerResponse.schemaJson(notFoundSchema)(
    { error: 'not_found' },
    { headers: responseHeaders, status: 404 },
  );
});

const DatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* databaseLive() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
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

const program = Effect.gen(function* runLocalDispatcher() {
  const transport = yield* emailTransport;
  const port = yield* Config.Int('EMAIL_DISPATCHER_PORT').pipe(Config.withDefault(3096));
  const intervalMs = yield* Config.Int('EMAIL_DISPATCHER_INTERVAL_MS').pipe(Config.withDefault(2000));
  const databaseScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
  const healthScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
  const server = yield* NodeHttpServer.make(() => createServer(), { host: '127.0.0.1', port }).pipe(
    Scope.provide(healthScope),
  );
  yield* server.serve(healthResponse).pipe(Scope.provide(healthScope));
  yield* Console.log(
    `[email] local dispatcher; ${transport.provider.label ?? 'NO provider'}; receipts at /shell-super-app-api/email/deliveries`,
  );
  // Keep the database scope alive until the last active cycle has finished.
  const database = yield* Effect.cached(Layer.buildWithScope(DatabaseLive, databaseScope));
  const stopping = yield* Ref.make(false);
  yield* waitForStop.pipe(
    Effect.tap(() => Ref.set(stopping, true)),
    Effect.andThen(Scope.close(healthScope, Exit.void)),
    Effect.forkChild,
  );
  while (!(yield* Ref.get(stopping))) {
    // Catch failed cycles, including defects, without overlapping or retrying an individual send.
    yield* database.pipe(
      Effect.flatMap((context) => Effect.provideContext(dispatchEmailBatch, context)),
      Effect.catchCause(() => Console.error('[email] cycle failed')),
    );
    yield* Effect.sleep(intervalMs);
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.tapCause(() => Console.error('[email] dispatcher failed to start'))),
  );
  if (Exit.isFailure(exit)) {
    process.exitCode = 1;
  }
}
