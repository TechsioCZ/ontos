import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime/modules/active-application-composition';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeHttpClient } from '@effect/platform-node';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Clock, Context, DateTime, Effect, Layer, Option, Predicate, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { HttpApi } from 'effect/unstable/httpapi';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { MODULE_API_REVISION_HEADER } from '../../src/module-api/admission.ts';
import { dispatchModuleApiRequest, ModuleApiTransportLive } from '../../src/module-api/transport.ts';
import { makeCompositionSnapshot, sealComposition } from '../fixtures/application-composition.ts';

const appId = 'native-owner-fixture';
const buildMarker = 'node-fixture.1 / immutable';
const issuer = 'https://shell.ontos.test';
const kid = 'native-owner-process-test';
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'gateway-session-ref',
  authenticationNamespaceId: 'test.native-owner.v1',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const ReadyEventSchema = Schema.Struct({ event: Schema.Literal('ready'), origin: Schema.String, pid: Schema.Number });
const ConfiguredEventSchema = Schema.Struct({ event: Schema.Literal('configured') });
const StreamClosedEventSchema = Schema.Struct({ event: Schema.Literal('stream-closed'), path: Schema.String });
const RequestAbortedEventSchema = Schema.Struct({ event: Schema.Literal('request-aborted'), path: Schema.String });
const OwnerEventSchema = Schema.Union([
  ReadyEventSchema,
  ConfiguredEventSchema,
  StreamClosedEventSchema,
  RequestAbortedEventSchema,
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

class OwnerProcessStartupError extends Schema.TaggedError<OwnerProcessStartupError>()('OwnerProcessStartupError', {
  reason: Schema.String,
}) {}

type NativeNodeServerFactory = (handler: (request: Request) => PromiseLike<Response>) => PromiseLike<Server>;
const NativeNodeAdapterSchema = Schema.Struct({
  createNodeServer: Schema.declare<NativeNodeServerFactory>((value): value is NativeNodeServerFactory =>
    Predicate.isFunction(value),
  ),
});

const startShellServer = Effect.fn('NativeModuleTransportTest.startShellServer')(function* startNativeShellServer(
  handler: (request: Request) => PromiseLike<Response>,
) {
  const shellRequire = createRequire(path.resolve('package.json'));
  const bffRequire = createRequire(shellRequire.resolve('@modern-js/bff-effect'));
  const adapter = yield* Schema.decodeUnknownEffect(NativeNodeAdapterSchema)(bffRequire('@modern-js/server-core/node'));
  const ingress: { aborted: boolean; connection: string | null; path: string }[] = [];
  const server = yield* Effect.acquireRelease(
    Effect.promise(() =>
      adapter.createNodeServer((request) => {
        const observed = {
          aborted: request.signal.aborted,
          connection: request.headers.get('connection'),
          path: new URL(request.url).pathname,
        };
        ingress.push(observed);
        request.signal.addEventListener(
          'abort',
          () => {
            observed.aborted = true;
          },
          { once: true },
        );
        return handler(request);
      }),
    ),
    (ownedServer) =>
      Effect.callback<true>((resume) => {
        ownedServer.close(() => resume(Effect.succeed(true)));
        ownedServer.closeAllConnections();
      }),
  );
  yield* Effect.callback<true, OwnerProcessStartupError>((resume) => {
    const failed = (error: Error): void => {
      resume(Effect.fail(new OwnerProcessStartupError({ reason: error.message })));
    };
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => resume(Effect.succeed(true)));
    return Effect.sync(() => server.removeListener('error', failed));
  });
  const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }))(server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const clientServices = yield* Layer.build(NodeHttpClient.layerNodeHttp);
  const client = Context.get(clientServices, HttpClient.HttpClient);
  const targetRequest = (request: Request) => {
    const source = new URL(request.url);
    return new Request(`${origin}${source.pathname}${source.search}`, request);
  };
  return {
    handler: (request: Request) => fetch(targetRequest(request), { redirect: 'manual' }),
    ingress,
    nativeHandler: Effect.fn('NativeModuleTransportTest.executeWireRequest')(function* executeNativeRequest(
      request: Request,
    ) {
      const forwarded = targetRequest(request);
      const nativeRequest = HttpClientRequest.fromWeb(forwarded);
      if (forwarded.body === null) {
        return yield* client.execute(nativeRequest);
      }
      const body = yield* Effect.promise(() => forwarded.text());
      return yield* client.execute(HttpClientRequest.bodyText(nativeRequest, body));
    }),
    origin,
  };
});

const awaitChildExit = (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) =>
  Effect.callback<true>((resume) => {
    const onClose = (): void => {
      resume(Effect.succeed(true));
    };
    child.once('close', onClose);
    child.kill(signal);
    return Effect.sync(() => child.removeListener('close', onClose));
  });

const closeOwner = (child: ChildProcessWithoutNullStreams) => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Effect.void;
  }
  return awaitChildExit(child, 'SIGTERM').pipe(
    Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => awaitChildExit(child, 'SIGKILL') }),
  );
};

const startOwner = Effect.fn('NativeModuleTransportTest.startOwner')(function* startOwnerProcess() {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(
        process.execPath,
        ['--experimental-strip-types', path.resolve('../../scripts/integration/fixtures/native-owner-process.mts')],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    ),
    closeOwner,
  );
  const events: OwnerEvent[] = [];
  const observers = new Set<(event: OwnerEvent) => void>();
  let stderr = '';
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines = yield* Effect.acquireRelease(
    Effect.sync(() => createInterface({ input: child.stdout })),
    (output) => Effect.sync(() => output.close()),
  );
  lines.on('line', (line) => {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(OwnerEventSchema))(line);
    if (Option.isSome(decoded)) {
      events.push(decoded.value);
      for (const observe of observers) {
        observe(decoded.value);
      }
    }
  });
  const waitFor = <Event extends OwnerEvent>(schema: Schema.Schema<Event>, expectedEvent: Event['event']) =>
    Effect.callback<Event, OwnerProcessStartupError>((resume) => {
      const isKind = Schema.is(schema);
      const matching = events.find(isKind);
      if (matching !== undefined) {
        resume(Effect.succeed(matching));
        return Effect.void;
      }
      const observe = (event: OwnerEvent): void => {
        if (isKind(event)) {
          resume(Effect.succeed(event));
        }
      };
      const failed = (): void => {
        resume(Effect.fail(new OwnerProcessStartupError({ reason: `Owner process startup failed: ${stderr}` })));
      };
      const cleanup = (): void => {
        observers.delete(observe);
        child.removeListener('error', failed);
        child.removeListener('exit', failed);
      };
      observers.add(observe);
      child.once('error', failed);
      child.once('exit', failed);
      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: '15 seconds',
        orElse: () =>
          Effect.fail(
            new OwnerProcessStartupError({
              reason: `Owner event ${expectedEvent} timed out; observed: ${events.map((event) => event.event).join(', ')}; stderr: ${stderr}`,
            }),
          ),
      }),
    );
  const ready = yield* waitFor(ReadyEventSchema, 'ready');
  return { child, events, origin: ready.origin, pid: ready.pid, waitFor };
});

const createFixture = Effect.fn('NativeModuleTransportTest.createFixture')(function* createNativeFixture(
  compiledBuildMarker = buildMarker,
  compiledAppId = appId,
  redirectTarget?: string,
) {
  const owner = yield* startOwner();
  const original = yield* makeCompositionSnapshot([
    makeModuleContractFixture({ appId, buildMarker, moduleId: 'test.native.owner' }),
  ]);
  const snapshot: ActiveApplicationCompositionSnapshot = {
    ...original,
    composition: sealComposition({
      ...original.composition,
      modules: original.composition.modules.map((module) => ({
        ...module,
        backend: { baseUrl: owner.origin, transport: 'node-http' as const },
      })),
    }),
  };
  const keys = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = {
    ...(yield* Effect.promise(() => exportJWK(keys.publicKey))),
    alg: 'EdDSA',
    kid,
    use: 'sig',
  };
  yield* Effect.sync(() => {
    owner.child.stdin.write(
      `${JSON.stringify({
        appId: compiledAppId,
        buildMarker: compiledBuildMarker,
        composition: snapshot.composition,
        issuer,
        jwks: JSON.stringify({ keys: [publicJwk] }),
        redirectTarget,
      })}\n`,
    );
  });
  yield* owner.waitFor(ConfiguredEventSchema, 'configured');
  const authorize = (revision = snapshot.composition.revision) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.promise(() =>
          new SignJWT({
            compositionRevision: revision,
            principal,
            targetBuildMarker: buildMarker,
            ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
          })
            .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
            .setIssuer(issuer)
            .setAudience(appId)
            .setSubject(principal.principalId)
            .setIssuedAt(Math.floor(now / 1000))
            .setExpirationTime(Math.floor(now / 1000) + 300)
            .setJti(globalThis.crypto.randomUUID())
            .sign(keys.privateKey),
        ),
      ),
      Effect.map((token) => `Bearer ${token}`),
    );
  const layer = makeActiveApplicationCompositionLayer(Effect.succeed(snapshot));
  const router = yield* Effect.acquireRelease(
    Effect.sync(() =>
      assembleEffectBffRuntime({
        api: HttpApi.make('NativeModuleTransportProofApi'),
        handlers: Layer.empty,
        transport: ModuleApiTransportLive.pipe(Layer.provide(layer)),
      }).createHandler({ dataPlatform: { batch: { enabled: false }, enabled: false }, openapi: false }),
    ),
    (ownedRouter) => Effect.promise(() => ownedRouter.dispose()),
  );
  const server = yield* startShellServer(router.handler);
  const request = (
    endpoint: string,
    authorization: string,
    options: RequestInit = {},
    revision = snapshot.composition.revision,
  ) => {
    const headers = new Headers(options.headers);
    headers.set('authorization', authorization);
    headers.set(MODULE_API_REVISION_HEADER, revision);
    headers.set('x-correlation-id', 'native-process-correlation');
    return new Request(
      `https://shell.ontos.test/module-api/${appId}/${encodeURIComponent(buildMarker)}/${appId}-api/${endpoint}`,
      { ...options, headers },
    );
  };
  return { authorize, layer, owner, request, server, snapshot };
});

it.live('forwards POST with dotted owner path, query, body and headers to an independent authorized process', () =>
  Effect.gen(function* preservesNativePost() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    expect(fixture.owner.pid).not.toBe(process.pid);
    const response = yield* fixture.server.nativeHandler(
      fixture.request('records/item.v1?sort=latest&limit=5', authorization, {
        body: 'write payload',
        headers: {
          connection: 'x-connection-secret',
          cookie: 'shell-session=private-test-secret',
          host: 'attacker.invalid',
          'idempotency-key': 'process-write-key',
          'x-connection-secret': 'must-be-stripped',
        },
        method: 'POST',
      }),
    );
    const body = yield* response.json;
    expect(fixture.server.ingress[0]?.connection).toBe('x-connection-secret');
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toBe('application/vnd.ontos-owner-fixture+json');
    expect(response.headers['x-owner-process-pid']).toBe(String(fixture.owner.pid));
    expect(body).toEqual({
      authorization,
      body: 'write payload',
      buildMarker,
      connectionSecret: null,
      cookie: null,
      correlationId: 'native-process-correlation',
      host: new URL(fixture.owner.origin).host,
      idempotencyKey: 'process-write-key',
      method: 'POST',
      path: `/${appId}-api/records/item.v1`,
      query: '?sort=latest&limit=5',
      receivedRevision: fixture.snapshot.composition.revision,
      verifiedRevision: fixture.snapshot.composition.revision,
    });
  }).pipe(Effect.scoped),
);

it.live('retains HEAD and dotted paths through the native router and owner process', () =>
  Effect.gen(function* preservesHead() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() =>
      fixture.server.handler(fixture.request('schema.v1.json?format=full', authorization, { method: 'HEAD' })),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe('');
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toEqual([
      { body: '', event: 'received', method: 'HEAD', path: `/${appId}-api/schema.v1.json`, query: '?format=full' },
    ]);
  }).pipe(Effect.scoped),
);

it.live('returns owner redirects without following them or exposing signed credentials to another origin', () =>
  Effect.gen(function* keepsOwnerRedirect() {
    const outside = yield* startShellServer(() => Promise.resolve(new Response('Unexpected redirected request')));
    const externalLocation = `${outside.origin}/unapproved-target`;
    const fixture = yield* createFixture(buildMarker, appId, externalLocation);
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('redirect', authorization)));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`/${appId}-api/redirect-target`);
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toHaveLength(1);
    expect(
      fixture.owner.events.some((event) => event.event === 'received' && event.path.endsWith('/redirect-target')),
    ).toBe(false);
    const externalResponse = yield* Effect.promise(() =>
      fixture.server.handler(fixture.request('redirect-external', authorization)),
    );
    expect(externalResponse.status).toBe(307);
    expect(externalResponse.headers.get('location')).toBe(externalLocation);
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toHaveLength(2);
    expect(fixture.owner.events.filter((event) => event.event === 'business')).toHaveLength(2);
    expect(outside.ingress).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('preserves binary response bytes and separate Set-Cookie headers through the native router', () =>
  Effect.gen(function* preservesBinaryResponse() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('binary', authorization)));
    const bytes = yield* Effect.promise(() => response.arrayBuffer());
    expect([...new Uint8Array(bytes)]).toEqual([0, 255, 1, 128]);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.getSetCookie()).toEqual(['ownerA=1; Path=/', 'ownerB=2; HttpOnly']);
  }).pipe(Effect.scoped),
);

it.live('preserves cookies with the same name and different paths through the pinned Node adapter', () =>
  Effect.gen(function* preservesDuplicateCookieNames() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('cookies', authorization)));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(['sid=root; Path=/', 'sid=module; Path=/module']);
    expect(yield* Effect.promise(() => response.text())).toBe('cookies preserved');
  }).pipe(Effect.scoped),
);

it.live('preserves gzip and brotli owner bytes with their original encoding and length headers', () =>
  Effect.gen(function* preservesCompressedWireBytes() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const bytes = new Uint8Array([0, 255, 1, 128]);
    const representations = [
      { bytes: gzipSync(bytes), encoding: 'gzip', endpoint: 'compressed' },
      { bytes: brotliCompressSync(bytes), encoding: 'br', endpoint: 'compressed-br' },
    ];
    for (const representation of representations) {
      const response = yield* fixture.server.nativeHandler(fixture.request(representation.endpoint, authorization));
      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe(representation.encoding);
      expect(response.headers['content-length']).toBe(String(representation.bytes.byteLength));
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect([...new Uint8Array(yield* response.arrayBuffer)]).toEqual([...representation.bytes]);
    }
  }).pipe(Effect.scoped),
);

it.live('lets a native fetch consumer decode a compressed owner response exactly once', () =>
  Effect.gen(function* decodesCompressedOwnerResponseOnce() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    for (const endpoint of ['compressed', 'compressed-br']) {
      const response = yield* Effect.promise(() => fixture.server.handler(fixture.request(endpoint, authorization)));
      expect(response.status).toBe(200);
      const bytes = yield* Effect.promise(() => response.arrayBuffer());
      expect([...new Uint8Array(bytes)]).toEqual([0, 255, 1, 128]);
    }
  }).pipe(Effect.scoped),
);

it.live('preserves multipart and streamed request bytes in the independent owner process', () =>
  Effect.gen(function* preservesStreamingRequestBytes() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const form = new FormData();
    form.set('note', 'native multipart body');
    form.set('attachment', new Blob([new Uint8Array([0, 255, 1, 128])]), 'record.v1.bin');
    const multipart = fixture.request('echo-bytes', authorization, { body: form, method: 'POST' });
    const expected = yield* Effect.promise(() => multipart.clone().arrayBuffer());
    const multipartResponse = yield* Effect.promise(() => fixture.server.handler(multipart));
    expect(multipartResponse.status).toBe(201);
    expect(multipartResponse.headers.get('content-type')).toBe(multipart.headers.get('content-type'));
    const multipartBytes = yield* Effect.promise(() => multipartResponse.arrayBuffer());
    expect([...new Uint8Array(multipartBytes)]).toEqual([...new Uint8Array(expected)]);

    const inputStream = Stream.concat(
      Stream.make(new Uint8Array([0, 255])),
      Stream.fromEffect(Effect.sleep('100 millis').pipe(Effect.as(new Uint8Array([1, 128])))),
    );
    const input = yield* Stream.toReadableStreamEffect(inputStream);
    const streamOptions = {
      body: input,
      duplex: 'half',
      headers: { 'content-type': 'application/octet-stream' },
      method: 'POST',
    } as const;
    const streamResponse = yield* Effect.promise(() =>
      fixture.server.handler(fixture.request('echo-bytes', authorization, streamOptions)),
    );
    expect(streamResponse.status).toBe(201);
    expect(streamResponse.headers.get('content-type')).toBe('application/octet-stream');
    const streamBytes = yield* Effect.promise(() => streamResponse.arrayBuffer());
    expect([...new Uint8Array(streamBytes)]).toEqual([0, 255, 1, 128]);
  }).pipe(Effect.scoped),
);

it.live('keeps a delayed owner stream alive after the native handler has returned headers', () =>
  Effect.gen(function* preservesDelayedStreaming() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() =>
      fixture.server.handler(fixture.request('delayed-stream', authorization)),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const reader = Option.getOrThrow(Option.fromNullOr(response.body)).getReader();
    const first = yield* Effect.promise(() => reader.read());
    expect(first.done).toBe(false);
    expect([...(first.value ?? [])]).toEqual([0, 255]);
    const second = yield* Effect.promise(() => reader.read());
    expect(second.done).toBe(false);
    expect([...(second.value ?? [])]).toEqual([1, 128]);
    expect((yield* Effect.promise(() => reader.read())).done).toBe(true);
    yield* fixture.owner.waitFor(StreamClosedEventSchema, 'stream-closed');
  }).pipe(Effect.scoped),
);

it.live('cancels the owner stream when the downstream Node client aborts', () =>
  Effect.gen(function* cancelsAbortedStreaming() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const controller = new AbortController();
    const response = yield* Effect.promise(() =>
      fixture.server.handler(fixture.request('abort-stream', authorization, { signal: controller.signal })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const reader = Option.getOrThrow(Option.fromNullOr(response.body)).getReader();
    const first = yield* Effect.promise(() => reader.read());
    expect(first.done).toBe(false);
    expect([...(first.value ?? [])]).toEqual([0, 255]);
    controller.abort();
    yield* Effect.sleep('100 millis');
    expect(fixture.server.ingress[0]?.aborted).toBe(true);
    const aborted = yield* fixture.owner.waitFor(RequestAbortedEventSchema, 'request-aborted');
    expect(aborted.path).toBe(`/${appId}-api/abort-stream`);
    const closed = yield* fixture.owner.waitFor(StreamClosedEventSchema, 'stream-closed');
    expect(closed.path).toBe(`/${appId}-api/abort-stream`);
  }).pipe(Effect.scoped),
);

it.live('fails with a typed unavailable response when the approved Node owner origin stops', () =>
  Effect.gen(function* rejectsUnavailableOwner() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    yield* closeOwner(fixture.owner.child);
    const error = yield* dispatchModuleApiRequest(fixture.request('records', authorization)).pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
    );
    expect(Predicate.isTagged(error, 'ModuleReleaseTransportError')).toBe(true);
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('records', authorization)));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('requires the receiving process own compiled release to match the signed approved release', () =>
  Effect.gen(function* rejectsWrongExecutable() {
    const fixture = yield* createFixture('other-compiled-build');
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('records', authorization)));
    expect(response.status).toBe(403);
    expect(yield* Effect.promise(() => response.text())).toBe('Owner release assertion rejected');
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toHaveLength(1);
    expect(fixture.owner.events.filter((event) => event.event === 'business')).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('requires the independently executing owner identity to match the signed audience', () =>
  Effect.gen(function* rejectsWrongOwnerIdentity() {
    const fixture = yield* createFixture(buildMarker, 'other-owner-fixture');
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('records', authorization)));
    expect(response.status).toBe(403);
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toHaveLength(1);
    expect(fixture.owner.events.filter((event) => event.event === 'business')).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('rejects stale document revisions before making any owner HTTP request', () =>
  Effect.gen(function* rejectsBeforeOwnerCall() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const response = yield* Effect.promise(() =>
      fixture.server.handler(fixture.request('records', authorization, {}, 'f'.repeat(64))),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('rejects malformed Connection metadata before contacting the owner process', () =>
  Effect.gen(function* rejectsMalformedConnection() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const response = yield* fixture.server.nativeHandler(
      fixture.request('records', authorization, { headers: { connection: 'not a header' } }),
    );
    expect(response.status).toBe(400);
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('rejects an expired authority before transport selection', () =>
  Effect.gen(function* rejectsExpiredComposition() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize();
    const error = yield* Effect.gen(function* expireAuthorityObservation() {
      yield* TestClock.setTime(DateTime.toEpochMillis(fixture.snapshot.validUntil) + 1);
      return yield* dispatchModuleApiRequest(fixture.request('records', authorization)).pipe(Effect.flip);
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(fixture.layer));
    expect(Predicate.isTagged(error, 'ActiveApplicationCompositionUnavailableError')).toBe(true);
    expect(fixture.owner.events.filter((event) => event.event === 'received')).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live('requires the independent owner to verify the signed revision even when the request header is current', () =>
  Effect.gen(function* rejectsStaleSignedClaims() {
    const fixture = yield* createFixture();
    const authorization = yield* fixture.authorize('e'.repeat(64));
    const response = yield* Effect.promise(() => fixture.server.handler(fixture.request('records', authorization)));
    expect(response.status).toBe(403);
    expect(fixture.owner.events.filter((event) => event.event === 'business')).toEqual([]);
  }).pipe(Effect.scoped),
);
