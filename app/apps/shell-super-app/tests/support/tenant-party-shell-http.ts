import { createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Predicate, Schema, Tracer } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import apiRuntime from '../../api/index.ts';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

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

class TenantPartyShellHttpTestError extends Schema.TaggedError<TenantPartyShellHttpTestError>()(
  'TenantPartyShellHttpTestError',
  {
    reason: Schema.String,
  },
) {}

const describe = Effect.sync(() => process.stdout.write(`${JSON.stringify(ultramodernDeliveryUnit)}\n`));

const serve = Effect.scoped(
  Effect.gen(function* serveTenantPartyShellHttp() {
    const app = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: () => new TenantPartyShellHttpTestError({ reason: 'The actual owner HTTP dispatcher failed' }),
        try: async () =>
          await createEffectBffTestHandler({
            module: { default: observedRuntime },
            prefix: shellAuthenticationApiContract.apiPrefix,
          }),
      }),
      (handler) => Effect.promise(handler.dispose.bind(handler)),
    );
    const server = yield* HttpServer.HttpServer;
    const application = Effect.gen(function* shellDefaultRuntimeRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        catch: (cause) => {
          process.stderr.write(
            `adapter: ${redactCredentials(String(Predicate.isError(cause) ? (cause.stack ?? cause.message) : cause)).slice(0, 4096)}\n`,
          );
          return new TenantPartyShellHttpTestError({ reason: 'The Shell test HTTP adapter failed' });
        },
        try: async () => await app.handler(webRequest),
      });
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
      return yield* new TenantPartyShellHttpTestError({
        reason: 'The Shell test server requires a loopback TCP address',
      });
    }
    yield* Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({
          marker: ultramodernDeliveryUnit,
          port: address.port,
          type: 'ready',
        })}\n`,
      ),
    );
    return yield* Effect.never;
  }),
);

NodeRuntime.runMain(
  process.argv.includes('--describe')
    ? describe.pipe(Effect.provide(NodeServices.layer))
    : serve.pipe(Effect.provide(NodeHttpServer.layerTest)),
);
