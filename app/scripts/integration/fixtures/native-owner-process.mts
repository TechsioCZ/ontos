import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { ApplicationCompositionSchema, OntosDeploymentIdentitySchema } from '@app/core-runtime';
import { readVerifiedGatewayCompositionRevision } from '@app/core-runtime/auth/system-principal-context-provenance';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { NodeRuntime } from '@effect/platform-node';
import {
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { Cookies, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';

import {
  bindGatewayPrincipalVerifier,
  GatewayPrincipalVerifierLive,
} from '../../../packages/gateway-principal-verifier/src/server.ts';

const ConfigurationSchema = Schema.Struct({
  appId: OntosDeploymentIdentitySchema.fields.appId,
  buildMarker: OntosDeploymentIdentitySchema.fields.buildMarker,
  composition: ApplicationCompositionSchema,
  issuer: Schema.String,
  jwks: Schema.String,
  redirectTarget: Schema.optionalKey(Schema.URLFromString),
});
const binaryContentType = 'application/octet-stream';

const OwnerEventSchema = Schema.Union([
  Schema.Struct({ event: Schema.Literal('ready'), origin: Schema.String, pid: Schema.Number }),
  Schema.Struct({ event: Schema.Literal('configured') }),
  Schema.Struct({ event: Schema.Literal('stream-closed'), path: Schema.String }),
  Schema.Struct({ event: Schema.Literal('request-aborted'), path: Schema.String }),
  Schema.Struct({
    body: Schema.String,
    event: Schema.Literal('received'),
    method: Schema.String,
    path: Schema.String,
    query: Schema.String,
  }),
  Schema.Struct({ event: Schema.Literal('business'), method: Schema.String, path: Schema.String }),
]);
type OwnerEvent = typeof OwnerEventSchema.Type;

type NativeNodeServerFactory = (handler: (request: Request) => PromiseLike<Response>) => PromiseLike<Server>;
const NativeNodeAdapterSchema = Schema.Struct({
  createNodeServer: Schema.declare<NativeNodeServerFactory>((value): value is NativeNodeServerFactory =>
    Predicate.isFunction(value),
  ),
});

class OwnerServerStartupError extends Schema.TaggedError<OwnerServerStartupError>()('OwnerServerStartupError', {
  reason: Schema.String,
}) {}

const OwnerCorrelationIdSchema = Schema.String.pipe(Schema.brand('OwnerFixtureCorrelationId'));
const OwnerIdempotencyKeySchema = Schema.String.pipe(Schema.brand('OwnerFixtureIdempotencyKey'));
const OwnerResponseSchema = Schema.Struct({
  authorization: Schema.RedactedFromValue(Schema.String),
  body: Schema.String,
  buildMarker: OntosDeploymentIdentitySchema.fields.buildMarker,
  connectionSecret: Schema.OptionFromNullOr(Schema.RedactedFromValue(Schema.String)),
  cookie: Schema.OptionFromNullOr(Schema.RedactedFromValue(Schema.String)),
  correlationId: Schema.OptionFromNullOr(OwnerCorrelationIdSchema),
  host: Schema.OptionFromNullOr(Schema.String),
  idempotencyKey: Schema.OptionFromNullOr(OwnerIdempotencyKeySchema),
  method: Schema.String,
  path: Schema.String,
  query: Schema.String,
  receivedRevision: Schema.optionalKey(Schema.String),
  verifiedRevision: Schema.optionalKey(Schema.String),
});

const emit = (message: OwnerEvent) =>
  Schema.encodeEffect(Schema.fromJsonString(OwnerEventSchema))(message).pipe(
    Effect.flatMap((document) =>
      Effect.sync(() => {
        process.stdout.write(`${document}\n`);
      }),
    ),
  );

const readConfiguration = Effect.callback<string>((resume) => {
  const input = createInterface({ input: process.stdin });
  input.once('line', (line) => {
    input.close();
    resume(Effect.succeed(line));
  });
  return Effect.sync(() => input.close());
}).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ConfigurationSchema))));

const ownerProcess = Effect.gen(function* runOwnerProcess() {
  const shellRequire = createRequire(path.resolve('package.json'));
  const bffRequire = createRequire(shellRequire.resolve('@modern-js/bff-effect'));
  const adapter = yield* Schema.decodeUnknownEffect(NativeNodeAdapterSchema)(bffRequire('@modern-js/server-core/node'));
  let ownerRouter =
    Option.none<ReturnType<typeof HttpRouter.toWebHandler<never, never, HttpRouter.HttpRouter, never>>>();
  const server = yield* Effect.acquireRelease(
    Effect.promise((): PromiseLike<Server> =>
      adapter.createNodeServer((request): PromiseLike<Response> => {
        request.signal.addEventListener(
          'abort',
          () => {
            const event = Result.getOrThrow(
              Schema.encodeResult(Schema.fromJsonString(OwnerEventSchema))({
                event: 'request-aborted',
                path: new URL(request.url).pathname,
              }),
            );
            process.stdout.write(`${event}\n`);
          },
          { once: true },
        );
        return Option.isSome(ownerRouter)
          ? ownerRouter.value.handler(request, Context.empty())
          : Promise.resolve(new Response('Owner has not been configured', { status: 503 }));
      }),
    ),
    (ownedServer) =>
      Effect.callback<true>((resume) => {
        ownedServer.close(() => resume(Effect.succeed(true)));
        ownedServer.closeAllConnections();
      }),
  );
  yield* Effect.callback<true, OwnerServerStartupError>((resume) => {
    const failed = (error: Error): void => {
      resume(Effect.fail(new OwnerServerStartupError({ reason: error.message })));
    };
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => resume(Effect.succeed(true)));
    return Effect.sync(() => server.removeListener('error', failed));
  });
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address());
  const origin = new URL(`http://127.0.0.1:${address.port}/`);
  yield* emit({ event: 'ready', origin: origin.href, pid: process.pid });
  const configuration = yield* readConfiguration;
  const compositionLive = makeActiveApplicationCompositionLayer(
    Effect.gen(function* currentOwnerAuthority() {
      const observedAt = yield* DateTime.now;
      return {
        composition: configuration.composition,
        observedAt,
        validUntil: DateTime.add(observedAt, { minutes: 10 }),
      };
    }),
  );
  const verificationLive = GatewayPrincipalVerifierLive.pipe(
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: configuration.issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: configuration.jwks,
        }),
      ),
    ),
  );
  const verifier = bindGatewayPrincipalVerifier(configuration.appId, {
    appId: configuration.appId,
    buildMarker: configuration.buildMarker,
  });
  const redirectLocations = new Map([
    [`/${configuration.appId}-api/redirect`, `/${configuration.appId}-api/redirect-target`],
  ]);
  if (configuration.redirectTarget !== undefined) {
    redirectLocations.set(`/${configuration.appId}-api/redirect-external`, configuration.redirectTarget.href);
  }
  const handle = Effect.gen(function* handleOwnerRequest() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const bodyBytes = yield* request.arrayBuffer;
    const body = new TextDecoder().decode(bodyBytes);
    const url = new URL(request.originalUrl, origin);
    yield* emit({ body, event: 'received', method: request.method, path: url.pathname, query: url.search });
    const principal = yield* verifier.verifyAndRedeem(Redacted.make(request.headers.authorization), {
      redemption: { consume: () => Effect.void },
    });
    yield* emit({ event: 'business', method: request.method, path: url.pathname });
    const headers = { 'x-owner-process-pid': String(process.pid) };
    if (url.pathname.endsWith('/compressed') || url.pathname.endsWith('/compressed-br')) {
      const isBrotli = url.pathname.endsWith('/compressed-br');
      const compress = isBrotli ? brotliCompressSync : gzipSync;
      return HttpServerResponse.uint8Array(compress(new Uint8Array([0, 255, 1, 128])), {
        contentType: binaryContentType,
        headers: { ...headers, 'content-encoding': isBrotli ? 'br' : 'gzip' },
      });
    }
    if (url.pathname.endsWith('/echo-bytes')) {
      return HttpServerResponse.uint8Array(new Uint8Array(bodyBytes), {
        contentType: request.headers['content-type'] ?? binaryContentType,
        headers,
        status: request.method === 'POST' ? 201 : 200,
      });
    }
    if (url.pathname.endsWith('/cookies')) {
      const cookieHeaders = new Headers({ ...headers, 'content-type': 'text/plain' });
      cookieHeaders.append(
        'set-cookie',
        Cookies.serializeCookie(Cookies.makeCookieUnsafe('sid', 'root', { path: '/' })),
      );
      cookieHeaders.append(
        'set-cookie',
        Cookies.serializeCookie(Cookies.makeCookieUnsafe('sid', 'module', { path: '/module' })),
      );
      return HttpServerResponse.raw(new Response('cookies preserved', { headers: cookieHeaders }));
    }
    if (url.pathname.endsWith('/delayed-stream') || url.pathname.endsWith('/abort-stream')) {
      const tail = url.pathname.endsWith('/abort-stream')
        ? Stream.fromEffectRepeat(Effect.sleep('100 millis').pipe(Effect.as(new Uint8Array([1, 128]))))
        : Stream.fromEffect(Effect.sleep('300 millis').pipe(Effect.as(new Uint8Array([1, 128]))));
      const bytes = Stream.concat(Stream.make(new Uint8Array([0, 255])), tail).pipe(
        Stream.onExit(() => emit({ event: 'stream-closed', path: url.pathname }).pipe(Effect.orDie)),
      );
      return HttpServerResponse.stream(bytes, { contentType: binaryContentType, headers });
    }
    if (url.pathname.endsWith('/binary')) {
      return HttpServerResponse.uint8Array(new Uint8Array([0, 255, 1, 128]), {
        contentType: binaryContentType,
        headers,
      }).pipe(
        HttpServerResponse.setCookieUnsafe('ownerA', '1', { path: '/' }),
        HttpServerResponse.setCookieUnsafe('ownerB', '2', { httpOnly: true }),
      );
    }
    const responseBody = yield* Schema.encodeEffect(Schema.fromJsonString(OwnerResponseSchema))({
      authorization: Redacted.make(request.headers.authorization ?? ''),
      body,
      buildMarker: configuration.buildMarker,
      connectionSecret: Option.map(Option.fromUndefinedOr(request.headers['x-connection-secret']), Redacted.make),
      cookie: Option.map(Option.fromUndefinedOr(request.headers.cookie), Redacted.make),
      correlationId: yield* Schema.decodeEffect(OwnerResponseSchema.fields.correlationId)(
        request.headers['x-correlation-id'] ?? null,
      ),
      host: Option.fromUndefinedOr(request.headers.host),
      idempotencyKey: yield* Schema.decodeEffect(OwnerResponseSchema.fields.idempotencyKey)(
        request.headers['idempotency-key'] ?? null,
      ),
      method: request.method,
      path: url.pathname,
      query: url.search,
      receivedRevision: request.headers['x-ontos-composition-revision'],
      verifiedRevision: readVerifiedGatewayCompositionRevision(principal),
    });
    const location = redirectLocations.get(url.pathname);
    if (location !== undefined) {
      return HttpServerResponse.text(responseBody, {
        contentType: 'application/vnd.ontos-owner-fixture+json',
        headers: { ...headers, location },
        status: 307,
      });
    }
    return HttpServerResponse.text(responseBody, {
      contentType: 'application/vnd.ontos-owner-fixture+json',
      headers,
      status: request.method === 'POST' ? 201 : 200,
    });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.text('Owner release assertion rejected', { status: 403 })),
    ),
  );
  const ownerServices = yield* Layer.build(Layer.merge(compositionLive, verificationLive));
  const router = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpRouter.add('*', '/*', handle.pipe(Effect.provideContext(ownerServices))).pipe(
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (ownedRouter) => Effect.promise((): PromiseLike<void> => ownedRouter.dispose()),
  );
  ownerRouter = Option.some(router);
  yield* emit({ event: 'configured' });
  yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(ownerProcess));
