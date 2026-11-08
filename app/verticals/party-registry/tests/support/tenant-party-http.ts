// @effect-diagnostics asyncFunction:off -- Native proof fixture child owns a Node HTTP listener and its lifecycle at the process entrypoint; expires: 2027-03-31.
import { DatabaseIdentityEnrollmentContext, makeDatabaseConfigLive } from '@app/core-runtime';
import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/party-registry-identity-contracts';
import { createEffectBffTestHandler, defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Layer, Predicate, Schema, Tracer } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { partyRegistryApiRuntime } from './party-registry-api-runtime.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import {
  partyRegistryActionRuntimeLive,
  partyRegistryOwnerActionApprovalsLive,
  partyRegistryAresSubjectServiceLive,
  partyRegistryReadRuntimeLive,
  partyRegistrySearchProjectionGatewayLive,
} from '../../api/party-registry-production-layers.ts';
import { partyRegistryApiContract } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { partyTestAccessGate } from './party-test-access-gate.ts';

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
const partyRegistryDatabaseConfigLive = makeDatabaseConfigLive(PARTY_REGISTRY_REQUEST_IDENTITY);

/**
 * The Party suite's own authority, flipped over the fixture's HTTP surface (see
 * `party-test-access-gate.ts`). The isolated database carries no v2 access intent and reaches no
 * engine, so the production default would refuse every protected read and Action; the suite still
 * proves a real revocation because the control really changes the gate's answer.
 */
const accessGate = partyTestAccessGate();
const partyRegistryDatabaseIdentityEnrollmentLive = Layer.succeed(
  DatabaseIdentityEnrollmentContext,
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
);
const runtimeDependenciesLive = Layer.mergeAll(
  partyRegistryDatabaseConfigLive,
  partyRegistryDatabaseIdentityEnrollmentLive,
  nodeCryptoLayer,
  accessGate.layer,
);
const gatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(partyRegistryDatabaseConfigLive),
);
const testPartyRuntime = partyRegistryApiRuntime(
  partyRegistryReadRuntimeLive.pipe(Layer.provide(runtimeDependenciesLive)),
  partyRegistryAresSubjectServiceLive,
  partyRegistrySearchProjectionGatewayLive.pipe(
    Layer.provide(Layer.merge(partyRegistryDatabaseConfigLive, partyRegistryDatabaseIdentityEnrollmentLive)),
  ),
  partyRegistryActionRuntimeLive.pipe(
    Layer.provideMerge(partyRegistryOwnerActionApprovalsLive),
    Layer.provide(runtimeDependenciesLive),
  ),
  gatewayAssertionRedemptionLive,
);

const observedRuntime = defineEffectBff({
  ...testPartyRuntime,
  layer: testPartyRuntime.layer.pipe(Layer.provide(Layer.succeed(Tracer.Tracer, defectTracer))),
});

/** Every Privacy-measure capability this module owns: the receipt read and the execution Action. */
const partyPrivacyMeasureCapabilityPrefix = 'party.registry.privacy-measure';
/**
 * The capability family a control flips. It defaults to this module's Privacy-measure pair, and a
 * suite that needs a different declared capability names it with a `capabilityPrefix` query
 * parameter, so both suites still prove a real refusal through this fixture's own gate.
 */
const controlledCapabilityPrefix = (requestUrl: string) =>
  new URL(requestUrl, 'http://localhost').searchParams.get('capabilityPrefix') ?? partyPrivacyMeasureCapabilityPrefix;

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
      // Suite controls: they flip this fixture's own gate answer, so the suite proves both a real
      // refusal and the same request succeeding once the capability is restored.
      const control = new URL(request.url, 'http://localhost');
      if (request.method === 'POST' && control.pathname === '/__1258/revoke-party-read') {
        accessGate.revoke(controlledCapabilityPrefix(request.url));
        return HttpServerResponse.empty();
      }
      if (request.method === 'POST' && control.pathname === '/__1258/grant-party-read') {
        accessGate.restore(controlledCapabilityPrefix(request.url));
        return HttpServerResponse.empty();
      }
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
