// @rstest-environment node
import { Data, Deferred, Effect, Exit, Fiber, Option, Result, Schema } from 'effect';
import { expect, it as test } from 'effect-rstest';

import {
  isOAuthPagePath,
  oauthPageSecurityHeaders,
  preloadModule,
  serveRootMetadataAlias,
  serveRootRoute,
  viaModule,
} from '../../../server/root-routes.ts';

const OAUTH_ALIAS = '/.well-known/oauth-authorization-server/shell-super-app-api/oauth';
const PRM_ALIAS = '/.well-known/oauth-protected-resource/mcp';

test('isOAuthPagePath matches login, pripojit and connect pages only', () => {
  for (const path of ['/cs/login', '/en/login', '/cs/pripojit', '/cs/pripojit/souhlas']) {
    expect(isOAuthPagePath(path)).toBe(true);
  }
  for (const path of ['/cs/', '/cs/loginx', '/cs/crm']) {
    expect(isOAuthPagePath(path)).toBe(false);
  }
});

test.effect(
  'serveRootMetadataAlias handles GET in-process, rejects writes, answers OPTIONS and passes other paths on',
  () =>
    Effect.gen(function* metadataMethods() {
      const recorded: string[] = [];
      const handleCanonical = (request: Request) =>
        Effect.sync(() => {
          recorded.push(request.url);
          return new Response('{"issuer":"x"}', { headers: { 'content-type': 'application/json' } });
        });
      const handler = serveRootMetadataAlias(handleCanonical);
      let nextCalls = 0;
      const next = Effect.sync(() => {
        nextCalls += 1;
      });

      const get = Option.getOrUndefined(
        yield* handler({ req: { method: 'GET', path: OAUTH_ALIAS }, res: new Response(null) }, next),
      );
      expect(get?.status).toBe(200);
      expect(yield* Effect.promise(async () => await get?.text())).toBe('{"issuer":"x"}');
      expect(get?.headers.get('access-control-allow-origin')).toBe('*');
      expect(recorded).toEqual([
        'https://shell.invalid/shell-super-app-api/oauth/.well-known/oauth-authorization-server',
      ]);
      expect(nextCalls).toBe(0);

      const head = Option.getOrUndefined(
        yield* handler({ req: { method: 'HEAD', path: OAUTH_ALIAS }, res: new Response(null) }, next),
      );
      expect(yield* Effect.promise(async () => await head?.text())).toBe('');

      const post = Option.getOrUndefined(
        yield* handler({ req: { method: 'POST', path: OAUTH_ALIAS }, res: new Response(null) }, next),
      );
      expect(post?.status).toBe(405);

      const options = Option.getOrUndefined(
        yield* handler({ req: { method: 'OPTIONS', path: OAUTH_ALIAS }, res: new Response(null) }, next),
      );
      expect(options?.status).toBe(204);

      const passthrough = yield* handler({ req: { method: 'GET', path: '/cs/login' }, res: new Response(null) }, next);
      expect(Option.isNone(passthrough)).toBe(true);
      expect(nextCalls).toBe(1);
    }),
);

test.effect('root metadata preserves canonical failure cache policy and removes credentialed CORS', () =>
  Effect.gen(function* metadataFailureHeaders() {
    const handler = serveRootMetadataAlias(() =>
      Effect.succeed(
        new Response('{"error":"unavailable"}', {
          headers: { 'access-control-allow-credentials': 'true', 'cache-control': 'no-store' },
          status: 503,
        }),
      ),
    );
    const response = Option.getOrUndefined(
      yield* handler({ req: { method: 'GET', path: OAUTH_ALIAS }, res: new Response(null) }, Effect.void),
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(response?.headers.get('access-control-allow-origin')).toBe('*');
    expect(response?.headers.has('access-control-allow-credentials')).toBe(false);
  }),
);

test.effect('oauthPageSecurityHeaders sets no-store and frame-ancestors on OAuth pages only', () =>
  Effect.gen(function* pageHeaders() {
    const page = { req: { method: 'GET', path: '/cs/login' }, res: new Response('<html>') };
    yield* oauthPageSecurityHeaders(page, Effect.void);
    expect(page.res.headers.get('cache-control')).toBe('no-store');
    expect(page.res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(page.res.headers.get('x-frame-options')).toBe('DENY');
    expect(yield* Effect.promise(async () => await page.res.text())).toBe('<html>');

    const original = new Response('ok');
    const other = { req: { method: 'GET', path: '/cs/' }, res: original };
    yield* oauthPageSecurityHeaders(other, Effect.void);
    expect(other.res).toBe(original);
    expect(other.res.headers.get('content-security-policy')).toBeNull();
  }),
);

interface FakeShellBff {
  readonly handleOAuthMetadata: (request: Request) => Effect.Effect<Response>;
  readonly handleRootRoute: (request: Request) => Effect.Effect<Response>;
}

const fakeShellBff: FakeShellBff = {
  handleOAuthMetadata: () => Effect.sync(() => Response.json({ issuer: 'x' })),
  handleRootRoute: (request) => Effect.sync(() => Response.json({ path: new URL(request.url).pathname })),
};

const rootRequest = (path: string) => ({
  req: { method: 'GET', path, raw: new Request(`http://127.0.0.1:3020${path}`), url: `http://127.0.0.1:3020${path}` },
  res: new Response(null),
});

test.effect(
  'root OAuth metadata and PRM requests sent while the BFF module is still loading wait for it and answer 200',
  () =>
    Effect.gen(function* awaitSharedModule() {
      let loads = 0;
      const loading = yield* Deferred.make<FakeShellBff>();
      const load = Effect.sync(() => {
        loads += 1;
      }).pipe(Effect.andThen(Deferred.await(loading)));
      const shellBff = yield* preloadModule(load);
      yield* Effect.addFinalizer(() => Deferred.succeed(loading, fakeShellBff));
      const preloading = yield* Effect.forkChild(shellBff, { startImmediately: true });
      // The host evaluates the load at startup, before any request.
      expect(loads).toBe(1);
      const metadata = serveRootMetadataAlias(viaModule(shellBff, (bff, request) => bff.handleOAuthMetadata(request)));
      const protectedResource = serveRootRoute(viaModule(shellBff, (bff, request) => bff.handleRootRoute(request)));
      const firstMetadata = yield* Effect.forkChild(metadata(rootRequest(OAUTH_ALIAS), Effect.void), {
        startImmediately: true,
      });
      const firstProtectedResource = yield* Effect.forkChild(protectedResource(rootRequest(PRM_ALIAS), Effect.void), {
        startImmediately: true,
      });
      yield* Deferred.succeed(loading, fakeShellBff);

      const metadataResponse = Option.getOrUndefined(yield* Fiber.join(firstMetadata));
      expect(metadataResponse?.status).toBe(200);
      const prm = Option.getOrUndefined(yield* Fiber.join(firstProtectedResource));
      expect(prm?.status).toBe(200);
      expect(
        yield* Effect.promise(async () => await prm?.text()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
        ),
      ).toEqual({ path: '/mcp-resource-metadata' });
      const later = Option.getOrUndefined(yield* metadata(rootRequest(OAUTH_ALIAS), Effect.void));
      expect(later?.status).toBe(200);
      // A later rebuild of dist/ on disk is never read by a running server.
      expect(loads).toBe(1);
      yield* Fiber.join(preloading);
    }).pipe(Effect.scoped),
);

class TestServerFailure extends Data.TaggedError('TestServerFailure')<{ readonly message: string }> {}

test.effect('a BFF module that cannot be loaded answers a retryable 503, and the next request loads it again', () =>
  Effect.gen(function* retryFailedModule() {
    let loads = 0;
    const shellBff = yield* preloadModule(
      Effect.suspend(() => {
        loads += 1;
        return loads <= 2
          ? Effect.fail(new TestServerFailure({ message: "Cannot find module '../api/index.js'" }))
          : Effect.succeed(fakeShellBff);
      }),
    );
    const metadata = serveRootMetadataAlias(viaModule(shellBff, (bff, request) => bff.handleOAuthMetadata(request)));
    const startup = yield* Effect.result(shellBff);
    expect(Result.isFailure(startup)).toBe(true);
    if (Result.isFailure(startup)) {
      expect(startup.failure.message).toContain('Cannot find module');
    }

    const unavailable = Option.getOrUndefined(yield* metadata(rootRequest(OAUTH_ALIAS), Effect.void));
    expect(unavailable?.status).toBe(503);
    expect(unavailable?.headers.get('cache-control')).toBe('no-store');
    expect(unavailable?.headers.get('retry-after')).toBe('1');
    expect(
      yield* Effect.promise(async () => await unavailable?.text()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
      ),
    ).toEqual({ error: 'temporarily_unavailable' });

    const recovered = Option.getOrUndefined(yield* metadata(rootRequest(OAUTH_ALIAS), Effect.void));
    expect(recovered?.status).toBe(200);
    expect(loads).toBe(3);
  }).pipe(Effect.scoped),
);

test.effect('viaModule preserves a typed handler failure instead of changing it to a module-load 503', () =>
  Effect.gen(function* retainHandlerFailure() {
    const failure = new TestServerFailure({ message: 'handler failed' });
    const handler = viaModule(Effect.succeed(fakeShellBff), () => Effect.fail(failure));
    const outcome = yield* Effect.result(handler(new Request('https://shell.invalid/mcp')));
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toBe(failure);
    }
  }),
);

test.effect('root request cancellation interrupts its Effect handler', () =>
  Effect.gen(function* cancelRootRequest() {
    const controller = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
    const entered = yield* Deferred.make<boolean>();
    let interrupted = false;
    const handler = serveRootRoute(() =>
      Deferred.succeed(entered, true).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const context = rootRequest(PRM_ALIAS);
    const request = new Request(context.req.raw, { signal: controller.signal });
    const pending = yield* Effect.forkChild(
      handler({ ...context, req: { ...context.req, raw: request } }, Effect.void),
    );
    yield* Deferred.await(entered);
    controller.abort();
    const outcome = yield* Fiber.await(pending);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(interrupted).toBe(true);
  }).pipe(Effect.scoped),
);

test.effect('an aborted waiter does not cancel or duplicate the shared BFF module load', () =>
  Effect.gen(function* isolateAbortedWaiter() {
    let loads = 0;
    const loading = yield* Deferred.make<FakeShellBff>();
    const shellBff = yield* preloadModule(
      Effect.sync(() => {
        loads += 1;
      }).pipe(Effect.andThen(Deferred.await(loading))),
    );
    const controller = new AbortController();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => controller.abort()).pipe(Effect.andThen(Deferred.succeed(loading, fakeShellBff))),
    );
    const startup = yield* Effect.forkChild(shellBff, { startImmediately: true });
    const route = serveRootRoute(viaModule(shellBff, (bff, request) => bff.handleRootRoute(request)));
    const original = rootRequest(PRM_ALIAS);
    const aborted = yield* Effect.forkChild(
      route(
        {
          ...original,
          req: {
            ...original.req,
            raw: new Request(original.req.raw, { signal: controller.signal }),
          },
        },
        Effect.void,
      ),
      { startImmediately: true },
    );
    const healthy = yield* Effect.forkChild(route(rootRequest(PRM_ALIAS), Effect.void), { startImmediately: true });
    controller.abort();
    const rejection = yield* Fiber.await(aborted);
    expect(Exit.isFailure(rejection)).toBe(true);
    expect(loads).toBe(1);
    yield* Deferred.succeed(loading, fakeShellBff);
    const healthyResponse = Option.getOrUndefined(yield* Fiber.join(healthy));
    expect(healthyResponse?.status).toBe(200);
    expect(loads).toBe(1);
    yield* Fiber.join(startup);
  }).pipe(Effect.scoped),
);
