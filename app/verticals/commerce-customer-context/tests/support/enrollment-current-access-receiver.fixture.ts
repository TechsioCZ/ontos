import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { inspect } from 'node:util';
import { defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { Cause, Config, Effect, Exit, Layer, Option, Redacted, Schema, Tracer } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { commerceTenantWorkloadCredentials } from '../../api/tenant-workload-credentials.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

class EnrollmentCurrentReceiverFailure extends Schema.TaggedError<EnrollmentCurrentReceiverFailure>()(
  'EnrollmentCurrentReceiverFailure',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

/** Test-only observation of the existing handler span, before Core projects its domain error. */
let observedBytes = 0;
export const makeEnrollmentFailureTracer = (
  secrets: readonly Redacted.Redacted[],
  write: (diagnostic: string) => void = (diagnostic) => {
    process.stderr.write(diagnostic);
  },
  selectedSpan = '',
): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        if (Exit.isSuccess(exit) || observedBytes > 0 || (selectedSpan.length > 0 && span.name !== selectedSpan)) {
          return;
        }
        const redacted = '[REDACTED]';
        let diagnostic = `${span.name}\n${Cause.pretty(exit.cause)}\n${inspect(exit.cause, { colors: false, customInspect: false, depth: 8, maxStringLength: Infinity })}`;
        for (const secret of secrets) {
          const value = Redacted.value(secret);
          if (value.length === 0) {
            continue;
          }
          diagnostic = diagnostic.replaceAll(value, redacted).replaceAll(JSON.stringify(value).slice(1, -1), redacted);
          const password = URL.canParse(value) ? new URL(value).password : '';
          if (password.length > 0) {
            diagnostic = diagnostic.replaceAll(password, redacted);
          }
          const privateKey = /"d"\s*:\s*"(?<secret>[^"]+)"/u.exec(value)?.[1];
          if (privateKey !== undefined) {
            diagnostic = diagnostic.replaceAll(privateKey, redacted);
          }
        }
        diagnostic = diagnostic
          .replaceAll(/(?<scheme>\w+:\/\/)[^\s/@]+:[^\s/@]+@/gu, '$<scheme>[REDACTED]@')
          .replaceAll(/eyJ[\w-]+\.[\w-]+\.[\w-]+/gu, redacted)
          .replaceAll(/(?<field>"d"\s*:\s*")[^"]+"/gu, '$<field>[REDACTED]"');
        // Redact whole values before any cap; never retain arbitrary tails of an oversized line.
        const lines = diagnostic
          .split('\n')
          .map((line) => (line.length > 16_384 ? '[stderr oversized line omitted]' : line));
        const bounded = `${lines.join('\n').slice(-6144)}\n`;
        observedBytes += bounded.length;
        write(bounded);
      };
      return span;
    },
  });

const describe = Effect.sync(() => process.stdout.write(`${JSON.stringify(ultramodernApiMarker)}\n`));
const serve = Effect.scoped(
  Effect.gen(function* serveActualEnrollmentCurrentReceiver() {
    const { default: apiRuntime } = yield* Effect.promise(async () => await import('../../api/index.ts'));
    const namedSecrets = yield* Effect.forEach(
      [
        'BETTER_AUTH_SECRET',
        'DATABASE_URL',
        'COMMERCE_TENANT_CREDENTIALS',
        'SPICEDB_PRESHARED_KEY',
        'ONTOS_GATEWAY_PRIVATE_JWK',
        'RESEND_API_KEY',
      ],
      (name) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make(''))),
    );
    // Each Tenant's keys are redacted individually; a span can carry one key without the surrounding map.
    const tenantCredentials = yield* Config.option(commerceTenantWorkloadCredentials);
    const tenantSecrets = Option.isNone(tenantCredentials)
      ? []
      : yield* Effect.all(
          tenantCredentials.value.tenantIds.map((tenantId) =>
            tenantCredentials.value
              .forTenant(tenantId)
              .pipe(Effect.map(({ coreIdentityApiKey, gatewayApiKey }) => [coreIdentityApiKey, gatewayApiKey])),
          ),
        );
    const secrets = [...namedSecrets, ...tenantSecrets.flat()];
    const selectedSpan = yield* Config.String('ONTOS_PREPROPOSAL_FAILURE_SPAN').pipe(Config.withDefault(''));
    const observed = defineEffectBff({
      ...apiRuntime,
      layer: apiRuntime.layer.pipe(
        Layer.provide(Layer.succeed(Tracer.Tracer, makeEnrollmentFailureTracer(secrets, undefined, selectedSpan))),
      ),
    });
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => observed.createHandler()),
      (handler) => Effect.promise(async () => await handler.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* forwardUnchangedDefaultRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: (cause) =>
            new EnrollmentCurrentReceiverFailure({
              cause: Redacted.make(cause),
              reason: 'The default enrollment Current HTTP adapter failed',
            }),
          try: async () => await runtime.handler(webRequest),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* new EnrollmentCurrentReceiverFailure({ reason: 'A loopback receiver address is required' });
    }
    yield* Effect.sync(() =>
      process.stdout.write(`${JSON.stringify({ marker: ultramodernApiMarker, port: address.port, type: 'ready' })}\n`),
    );
    return yield* Effect.never;
  }),
);

if (process.argv.includes('--describe')) {
  NodeRuntime.runMain(describe.pipe(Effect.provide(NodeServices.layer)));
} else if (process.argv.includes('--serve')) {
  NodeRuntime.runMain(serve.pipe(Effect.provide(NodeHttpServer.layerTest)));
}
