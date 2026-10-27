// Local after-commit host. Receipts/provider reads use the Shell API in every runtime;
// this loop keeps Mailpit SMTP and a loopback-only health endpoint for demo/up.sh.
import { createServer } from 'node:http';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Layer, Option, Schedule, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { dispatchEmailBatch } from '../../../packages/email-delivery/src/dispatcher/dispatch.ts';
import { emailTransport } from '../../../packages/email-delivery/src/transport.ts';

const healthSchema = Schema.Struct({
  ok: Schema.Literal(true),
  provider: Schema.Struct({ configured: Schema.Boolean, label: Schema.OptionFromNullOr(Schema.String) }),
});
const notFoundSchema = Schema.Struct({ error: Schema.Literal('not_found') });
const responseHeaders = { 'cache-control': 'no-store' };

export const healthResponse = Effect.gen(function* healthResponse() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method === 'GET' && request.url === '/healthz') {
    return yield* HttpServerResponse.schemaJson(healthSchema)(
      { ok: true, provider: { ...emailTransport.provider, label: Option.fromNullOr(emailTransport.provider.label) } },
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
const ServerLive = NodeHttpServer.layerConfig(createServer, {
  host: Config.succeed('127.0.0.1'),
  port: Config.Int('EMAIL_DISPATCHER_PORT').pipe(Config.withDefault(3096)),
});

// Catch failed cycles, including defects, without overlapping or retrying an individual send.
const dispatchCycle = dispatchEmailBatch.pipe(Effect.catchCause(() => Console.error('[email] cycle failed')));
const program = Effect.gen(function* main() {
  const intervalMs = yield* Config.Int('EMAIL_DISPATCHER_INTERVAL_MS').pipe(Config.withDefault(2000));
  yield* HttpServer.serveEffect(healthResponse);
  yield* Console.log(
    `[email] local dispatcher; ${emailTransport.provider.label ?? 'NO provider'}; receipts at /shell-super-app-api/email/deliveries`,
  );
  yield* dispatchCycle.pipe(Effect.repeat(Schedule.spaced(intervalMs)));
});

if (import.meta.main) {
  NodeRuntime.runMain(
    program.pipe(
      Effect.provide(Layer.mergeAll(DatabaseLive, ServerLive)),
      Effect.scoped,
      Effect.tapError(() => Console.error('[email] dispatcher failed to start')),
    ),
  );
}
