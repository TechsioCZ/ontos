// @effect-diagnostics asyncFunction:off -- Native proof fixture child owns a Node HTTP listener and its lifecycle at the process entrypoint; expires: 2027-03-31.
import { createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Predicate, Schema, Tracer } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import apiRuntime from '../../api/index.ts';
import { partyRegistryApiContract } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const REDACTED = '[REDACTED]';
const redactCredentials = (text: string) =>
  text
    .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, `$<scheme>${REDACTED}@`)
    .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, REDACTED)
    .replaceAll(/(?<field>Bearer\s+)\S+/gu, `$<field>${REDACTED}`);

/** Test-only: report failed-span causes (bounded, private stderr), credentials redacted before the cap. */
let observedBytes = 0;
const defectTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    const end = span.end.bind(span);
    span.end = (endTime, exit) => {
      end(endTime, exit);
      if (Exit.isSuccess(exit) || observedBytes > 49_152) {
        return;
      }
      const diagnostic = redactCredentials(`${span.name}\n${Cause.pretty(exit.cause)}`)
        .replaceAll(/(?<field>(?:api[-_]?key|secret|token|password)["':= ]+)[^\s"',]+/giu, `$<field>${REDACTED}`)
        .split('\n')
        .map((line) => (line.length > 4096 ? '[stderr oversized line omitted]' : line))
        .join('\n');
      const bounded = `${diagnostic.slice(0, 4096)}\n`;
      observedBytes += bounded.length;
      process.stderr.write(bounded);
    };
    return span;
  },
});
const observedRuntime = defineEffectBff({
  ...apiRuntime,
  layer: apiRuntime.layer.pipe(Layer.provide(Layer.succeed(Tracer.Tracer, defectTracer))),
});

// Test-only: the default Effect logger writes to stdout (the protocol channel); copy error-level lines to private stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (
  chunk: string | Uint8Array,
  encodingOrOnWritten?: BufferEncoding | ((error?: Error | null) => void),
  onWritten?: (error?: Error | null) => void,
) => {
  const text = Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk);
  if (/level=(?:ERROR|FATAL|WARN)/u.test(text) && observedBytes <= 49_152) {
    const redacted = redactCredentials(text).slice(0, 4096);
    observedBytes += redacted.length;
    process.stderr.write(`${redacted}\n`);
  }
  return Predicate.isFunction(encodingOrOnWritten)
    ? writeStdout(chunk, encodingOrOnWritten)
    : writeStdout(chunk, encodingOrOnWritten, onWritten);
};

class TenantPartyHttpTestError extends Schema.TaggedError<TenantPartyHttpTestError>()('TenantPartyHttpTestError', {
  reason: Schema.String,
}) {}

const PartyApiMarkerSchema = Schema.Struct({
  appId: Schema.Literal('party-registry'),
  build: Schema.String,
  buildMarker: Schema.String,
  deployProfile: Schema.Literal('cloudflare-ssr-mf-effect-v1'),
  kind: Schema.Literal('microvertical-delivery-unit'),
  packageName: Schema.Literal('@app/party-registry'),
  schemaVersion: Schema.Literal(1),
  sourceRevision: Schema.String,
  surface: Schema.Literal('api'),
  unitId: Schema.Literal('app/party-registry'),
  version: Schema.String,
});
const PartyReadySchema = Schema.Struct({
  marker: PartyApiMarkerSchema,
  port: Schema.Number,
  type: Schema.Literal('ready'),
});
const describe = Effect.gen(function* describePartyMarker() {
  const marker = yield* Schema.decodeUnknownEffect(PartyApiMarkerSchema)(ultramodernApiMarker);
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(PartyApiMarkerSchema))(marker);
  yield* Effect.sync(() => process.stdout.write(`${document}\n`));
});

const serve = Effect.scoped(
  Effect.gen(function* serveTenantPartyHttp() {
    const app = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () => new TenantPartyHttpTestError({ reason: 'The actual owner HTTP dispatcher failed' }),
        try: () =>
          createEffectBffTestHandler({
            module: { default: observedRuntime },
            prefix: partyRegistryApiContract.apiPrefix,
          }),
      }),
      (handler) => Effect.promise(() => handler.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    const application = Effect.gen(function* partyDefaultRuntimeRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request);
      process.stderr.write(`party-request ${webRequest.method} ${new URL(webRequest.url).pathname}\n`);
      const response = yield* Effect.tryPromise({
        try: () => app.handler(webRequest),
        catch: (cause) => {
          process.stderr.write(
            `adapter: ${redactCredentials(String(Predicate.isError(cause) ? (cause.stack ?? cause.message) : cause)).slice(0, 4096)}\n`,
          );
          return new TenantPartyHttpTestError({ reason: 'The Party test HTTP adapter failed' });
        },
      });
      process.stderr.write(`party-response ${response.status}\n`);
      if (response.status >= 500) {
        const body = yield* Effect.promise(async () => await response.clone().text());
        process.stderr.write(
          `HTTP ${response.status} ${webRequest.method} ${new URL(webRequest.url).pathname}\n${redactCredentials(body).slice(0, 2048)}\n`,
        );
      }
      return HttpServerResponse.fromWeb(response);
    });
    yield* server.serve(
      application.pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() =>
            process.stderr.write(`request-cause: ${redactCredentials(Cause.pretty(cause)).slice(0, 4096)}\n`),
          ),
        ),
      ),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new TenantPartyHttpTestError({ reason: 'The Party test server requires a loopback TCP address' });
    }
    const marker = yield* Schema.decodeUnknownEffect(PartyApiMarkerSchema)(ultramodernApiMarker);
    const ready = yield* Schema.encodeEffect(Schema.fromJsonString(PartyReadySchema))({
      marker,
      port: address.port,
      type: 'ready',
    });
    yield* Effect.sync(() => process.stdout.write(`${ready}\n`));
    return yield* Effect.never;
  }),
);

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* runPartyHttpFixture() {
      if (process.argv.includes('--describe')) {
        const context = yield* Layer.build(NodeServices.layer);
        return yield* describe.pipe(Effect.provideContext(context));
      }
      const context = yield* Layer.build(NodeHttpServer.layerTest);
      return yield* serve.pipe(Effect.provideContext(context));
    }),
  ),
);
