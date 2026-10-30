import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  createEffectBffEdgeDispatcher,
} from '@modern-js/bff-effect/effect-edge';
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Predicate, Schema, Stream } from 'effect';
import { forEach } from 'effect/Effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { transform } from 'esbuild';

const packageRoot = new URL(
  '../../apps/shell-super-app/node_modules/@modern-js/app-tools-extensions/',
  import.meta.url,
);
const dispatchFragment = 'cloudflare-entry.005-worker-dispatch.mjs';
const defaultAuthorization = 'fixture-one';
const fixtureWorker = 'fixture-worker';
// The emitter in cloudflare/index concatenates these actual shipped fragments without separators.
const fragments = [
  'cloudflare-entry.001-bootstrap-security.mjs',
  'cloudflare-entry.002-assets-routes.mjs',
  'cloudflare-entry.003-i18n-locales.mjs',
  'cloudflare-entry.004-rendering-css.mjs',
  dispatchFragment,
  'cloudflare-entry.006-fetch-handler.mjs',
];
const manifest = {
  bff: {
    dispatcherExport: 'createDispatcher',
    effect: {
      crossProjectPolicy: {
        allowUnknownOperations: false,
        enabled: false,
        expectedOperationContracts: {},
        requireEnvelope: false,
        requireOperationContext: false,
        requireOperationContextDetails: false,
        requireOperationSchemaHash: false,
        requireOperationVersion: false,
      },
    },
    prefix: '/api',
    runtimeFramework: 'effect',
    worker: fixtureWorker,
  },
};

const ResourceResponse = Schema.Struct({ authorization: Schema.String, id: Schema.Finite, open: Schema.Boolean });
class RequestResource extends Context.Service<
  RequestResource,
  { readonly id: number; readonly isOpen: () => boolean }
>()('emitted-dispatcher-test/RequestResource') {}

const api = HttpApi.make('EmittedDispatcherLifetime').add(
  HttpApiGroup.make('fixture')
    .add(HttpApiEndpoint.get('read', '/read', { success: ResourceResponse }))
    .add(HttpApiEndpoint.get('stream', '/stream', { success: Schema.String }))
    .add(HttpApiEndpoint.get('defect', '/defect', { success: ResourceResponse }))
    .add(HttpApiEndpoint.head('empty', '/empty', { success: Schema.Void })),
);

const requestContext = () => {
  const jobs: Promise<unknown>[] = [];
  return {
    jobs,
    // A method deliberately verifies that the emitted waitUntil adapter preserves its receiver.
    waitUntil(job: Promise<unknown>) {
      this.jobs.push(job);
    },
  };
};
type Dispatcher = Awaited<ReturnType<typeof createEffectBffEdgeDispatcher>>;
type DispatcherFactory = (
  options: Omit<Parameters<typeof createEffectBffEdgeDispatcher>[0], 'module'>,
) => ReturnType<typeof createEffectBffEdgeDispatcher>;
type WorkerFetch = (
  request: Request,
  env: { readonly requestMarker: string },
  context: ReturnType<typeof requestContext>,
) => ReturnType<Dispatcher['dispatch']>;
const Entry = Schema.Struct({
  default: Schema.Struct({
    fetch: Schema.Opaque<WorkerFetch>()(Schema.Unknown.pipe(Schema.refine(Predicate.isFunction))),
  }),
});

const initializationGate = () => ({
  entered: Deferred.makeUnsafe<boolean>(),
  ready: Deferred.makeUnsafe<boolean>(),
});

const fixtureState = (
  gates: readonly ReturnType<typeof initializationGate>[] = [],
  failFirstInitialization = false,
) => {
  const acquired: number[] = [];
  const released: number[] = [];
  const sharedAcquired: number[] = [];
  const sharedReleased: number[] = [];
  const disposed: number[] = [];
  const dispatchers: Dispatcher[] = [];
  const initializations: ReturnType<typeof createEffectBffEdgeDispatcher>[] = [];
  return {
    acquired,
    creations: 0,
    dispatchers,
    disposed,
    failFirstInitialization,
    gates,
    initializations,
    released,
    sharedAcquired,
    sharedReleased,
  };
};

const requestServices = (state: ReturnType<typeof fixtureState>) =>
  Layer.effect(
    RequestResource,
    Effect.acquireRelease(
      Effect.sync(() => {
        const id = state.acquired.length + 1;
        let open = true;
        state.acquired.push(id);
        return {
          close: () => {
            open = false;
            state.released.push(id);
          },
          id,
          isOpen: () => open,
        };
      }),
      (resource) => Effect.sync(resource.close),
    ),
  );

const readResource = Effect.gen(function* readResource() {
  const resource = yield* RequestResource;
  const request = yield* HttpServerRequest.HttpServerRequest;
  return {
    authorization: request.headers.authorization ?? '',
    id: resource.id,
    open: resource.isOpen(),
  };
});
const streamResource = RequestResource.pipe(
  Effect.map((resource) =>
    HttpServerResponse.stream(
      Stream.make(new TextEncoder().encode(String(resource.id))).pipe(Stream.concat(Stream.never)),
    ),
  ),
);

const handlersFor = (state: ReturnType<typeof fixtureState>, attempt: number) => {
  const release = Effect.sync(() => state.sharedReleased.push(attempt));
  return HttpApiBuilder.group(api, 'fixture', (group) =>
    Effect.gen(function* buildHandlers() {
      yield* Effect.acquireRelease(
        Effect.sync(() => state.sharedAcquired.push(attempt)),
        () => release,
      );
      const gate = state.gates.at(attempt - 1);
      if (gate !== undefined) {
        yield* Deferred.succeed(gate.entered, true);
        yield* Deferred.await(gate.ready);
      }
      if (state.failFirstInitialization && attempt === 1) {
        return yield* Effect.die('controlled shared-handler initialization defect');
      }
      return group
        .handle('read', () => readResource)
        .handleRaw('stream', () => streamResource)
        .handle('defect', () => RequestResource.pipe(Effect.andThen(Effect.die('controlled request defect'))))
        .handle('empty', () => RequestResource.pipe(Effect.asVoid));
    }),
  );
};

const closeWorker = Effect.fn(function* closeWorker(state: ReturnType<typeof fixtureState>) {
  yield* forEach(state.gates, (gate) => Deferred.succeed(gate.ready, true));
  yield* Effect.promise(() => Promise.allSettled(state.initializations));
  yield* Effect.promise(() => Promise.all(state.dispatchers.map((dispatcher) => dispatcher.dispose())));
});

const loadFixture = (createDispatcher: DispatcherFactory) => Promise.resolve({ createDispatcher });
type EntryFactory = (
  workerManifest: typeof manifest,
  workerModuleLoaders: { readonly [fixtureWorker]: () => ReturnType<typeof loadFixture> },
) => Schema.Schema.Type<typeof Entry>;
const FactoryModule = Schema.Struct({
  createEntry: Schema.Opaque<EntryFactory>()(Schema.Unknown.pipe(Schema.refine(Predicate.isFunction))),
});

const emitEntryFactory = Effect.gen(function* emitEntryFactory() {
  const fs = yield* FileSystem.FileSystem;
  const source = (yield* forEach(fragments, (fragment) =>
    fs.readFileString(fileURLToPath(new URL(`dist/esm-node/templates/${fragment}`, packageRoot))),
  )).join('');
  const { code } = yield* Effect.promise(() => transform(source, { format: 'cjs', loader: 'js' }));
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-emitted-dispatcher-' });
  const filename = path.join(directory, 'entry-factory.mjs');
  // Import the actual emitted program as a module. The wrapper only supplies its two emitter inputs
  // and creates a fresh isolate per fixture; it does not implement dispatcher caching or lifecycle.
  yield* fs.writeFileString(
    filename,
    `export function createEntry(p_workerManifest, p_workerModuleLoaders) {
const module = { exports: {} };
const exports = module.exports;
${code}
return module.exports;
}
`,
  );
  return yield* Schema.decodeUnknownEffect(FactoryModule)(
    yield* Effect.tryPromise(() => import(pathToFileURL(filename).href)),
  );
});

const makeWorker = Effect.fn(function* makeWorker(
  gates: readonly ReturnType<typeof initializationGate>[],
  failFirstInitialization: boolean,
) {
  // The fixture owns every native runtime, including the cached winner the isolate normally owns.
  const state = yield* Effect.acquireRelease(
    Effect.sync(() => fixtureState(gates, failFirstInitialization)),
    closeWorker,
  );
  const services = requestServices(state);
  const createDispatcher: DispatcherFactory = (options) => {
    state.creations += 1;
    const attempt = state.creations;
    const initialization = createEffectBffEdgeDispatcher({
      ...options,
      module: assembleEffectBffRuntime({ api, handlers: handlersFor(state, attempt), services }),
    });
    state.initializations.push(initialization);
    return initialization.then((dispatcher) => {
      state.dispatchers.push(dispatcher);
      return {
        dispatch: dispatcher.dispatch,
        dispose: () => {
          state.disposed.push(attempt);
          return dispatcher.dispose();
        },
      };
    });
  };
  const factory = yield* emitEntryFactory;
  const entry = yield* Schema.decodeUnknownEffect(Entry)(
    factory.createEntry(manifest, { [fixtureWorker]: () => loadFixture(createDispatcher) }),
  );
  return {
    acquired: state.acquired,
    creations: () => state.creations,
    disposed: state.disposed,
    released: state.released,
    request: (pathname = '/read', authorization = defaultAuthorization, method = 'GET') => {
      const context = requestContext();
      return {
        context,
        response: Effect.promise(() =>
          entry.default.fetch(
            new Request(`https://fixture.invalid/api${pathname}`, { headers: { authorization }, method }),
            { requestMarker: authorization },
            context,
          ),
        ),
      };
    },
    sharedAcquired: state.sharedAcquired,
    sharedReleased: state.sharedReleased,
  };
});

const readResponse = Effect.fn(function* readResponse(response: Response) {
  expect(response.status).toBe(200);
  return yield* Schema.decodeUnknownEffect(ResourceResponse)(yield* Effect.promise(() => response.json()));
});
const drain = (context: ReturnType<typeof requestContext>) => Effect.promise(() => Promise.all(context.jobs));

it.live(
  'all four shipped dispatcher templates carry the same implementation',
  Effect.fn(function* shippedCopies() {
    const fs = yield* FileSystem.FileSystem;
    const copies = yield* forEach(['src', 'dist/cjs', 'dist/esm', 'dist/esm-node'], (directory) =>
      fs.readFileString(fileURLToPath(new URL(`${directory}/templates/${dispatchFragment}`, packageRoot))),
    );
    expect(new Set(copies).size).toBe(1);
  }, Effect.provide(NodeServices.layer)),
);

it.live(
  'the emitted entry reuses its settled router but not sequential request services or credentials',
  Effect.fn(
    function* sequentialRequests() {
      const worker = yield* makeWorker([], false);
      yield* forEach([defaultAuthorization, 'fixture-two'], (authorization, index) =>
        Effect.gen(function* serveRequest() {
          const request = worker.request('/read', authorization);
          expect(yield* readResponse(yield* request.response)).toEqual({ authorization, id: index + 1, open: true });
          expect(request.context.jobs).toHaveLength(1);
          yield* drain(request.context);
          expect(worker.released).toEqual(worker.acquired);
        }),
      );
      expect(worker.creations()).toBe(1);
      expect(worker.sharedAcquired).toEqual([1]);
      expect(worker.sharedReleased).toEqual([]);
      expect(worker.disposed).toEqual([]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'concurrent cold requests build independently, use the settled winner and dispose only the loser',
  Effect.fn(
    function* concurrentInitialization() {
      const firstGate = initializationGate();
      const secondGate = initializationGate();
      const worker = yield* makeWorker([firstGate, secondGate], false);
      const first = worker.request('/read', 'first');
      const firstFiber = yield* Effect.forkChild(first.response);
      yield* Deferred.await(firstGate.entered);
      const second = worker.request('/read', 'second');
      const secondFiber = yield* Effect.forkChild(second.response);
      // This cannot complete if the second request awaited the first request's pending initialization.
      yield* Deferred.await(secondGate.entered).pipe(Effect.timeout('5 seconds'));
      yield* Deferred.succeed(secondGate.ready, true);
      expect(yield* readResponse(yield* Fiber.join(secondFiber))).toEqual({
        authorization: 'second',
        id: 1,
        open: true,
      });
      yield* drain(second.context);
      expect(worker.sharedReleased).toEqual([]);
      yield* Deferred.succeed(firstGate.ready, true);
      expect(yield* readResponse(yield* Fiber.join(firstFiber))).toEqual({
        authorization: 'first',
        id: 2,
        open: true,
      });
      yield* drain(first.context);
      expect(worker.creations()).toBe(2);
      expect(worker.disposed).toEqual([1]);
      expect(worker.sharedReleased).toEqual([1]);
      expect(worker.released).toEqual([1, 2]);
      const warm = worker.request();
      yield* readResponse(yield* warm.response);
      yield* drain(warm.context);
      expect(worker.creations()).toBe(2);
      expect(worker.disposed).toEqual([1]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'failed native initialization releases its scope, returns the existing 500 and is not cached',
  Effect.fn(
    function* failedInitialization() {
      const worker = yield* makeWorker([], true);
      const failed = worker.request();
      const response = yield* failed.response;
      expect(response.status).toBe(500);
      expect(response.headers.get('x-modern-js-bff-dispatcher')).toBe('createDispatcher');
      expect(response.headers.get('x-modern-js-bff-worker')).toBe(fixtureWorker);
      expect(yield* Effect.promise(() => response.text())).toContain('Effect BFF dispatcher initialization failed:');
      expect(worker.sharedReleased).toEqual([1]);
      expect(worker.acquired).toEqual([]);
      const retry = worker.request();
      expect(yield* readResponse(yield* retry.response)).toEqual({
        authorization: defaultAuthorization,
        id: 1,
        open: true,
      });
      yield* drain(retry.context);
      const warm = worker.request();
      yield* readResponse(yield* warm.response);
      yield* drain(warm.context);
      expect(worker.creations()).toBe(2);
      expect(worker.disposed).toEqual([]);
      expect(worker.sharedReleased).toEqual([1]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'stream cancellation, completed bodies, empty bodies and request defects close only their own services',
  Effect.fn(
    function* streamingLifecycle() {
      const worker = yield* makeWorker([], false);
      const first = worker.request('/stream');
      const second = worker.request('/stream');
      const firstResponse = yield* first.response;
      const secondResponse = yield* second.response;
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      const firstReader = yield* Effect.acquireRelease(
        Effect.fromNullishOr(firstResponse.body?.getReader()),
        (reader) => Effect.promise(() => reader.cancel()),
      );
      const secondReader = yield* Effect.acquireRelease(
        Effect.fromNullishOr(secondResponse.body?.getReader()),
        (reader) => Effect.promise(() => reader.cancel()),
      );
      expect(new TextDecoder().decode((yield* Effect.promise(() => firstReader.read())).value)).toBe('1');
      expect(new TextDecoder().decode((yield* Effect.promise(() => secondReader.read())).value)).toBe('2');
      expect(worker.released).toEqual([]);
      expect(first.context.jobs).toHaveLength(1);
      expect(second.context.jobs).toHaveLength(1);
      yield* Effect.promise(() => firstReader.cancel());
      yield* drain(first.context);
      expect(worker.released).toEqual([1]);
      const completed = worker.request();
      expect(yield* readResponse(yield* completed.response)).toEqual({
        authorization: defaultAuthorization,
        id: 3,
        open: true,
      });
      yield* drain(completed.context);
      expect(worker.released).toEqual([1, 3]);
      yield* Effect.promise(() => secondReader.cancel());
      yield* drain(second.context);
      expect(worker.released).toEqual([1, 3, 2]);
      const empty = worker.request('/empty', defaultAuthorization, 'HEAD');
      expect((yield* empty.response).body).toBeNull();
      yield* drain(empty.context);
      const failed = worker.request('/defect');
      const failure = yield* failed.response;
      expect(failure.status).toBe(500);
      yield* Effect.promise(() => failure.arrayBuffer());
      yield* drain(failed.context);
      expect(worker.released).toEqual([1, 3, 2, 4, 5]);
      const recovery = worker.request();
      expect(yield* readResponse(yield* recovery.response)).toEqual({
        authorization: defaultAuthorization,
        id: 6,
        open: true,
      });
      yield* drain(recovery.context);
      expect(worker.released).toEqual([1, 3, 2, 4, 5, 6]);
      expect(worker.creations()).toBe(1);
      expect(worker.disposed).toEqual([]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live(
  'the fixture releases the isolate-owned winner once at teardown',
  Effect.fn(function* isolateTeardown() {
    const worker = yield* Effect.gen(function* useWorker() {
      const fixture = yield* makeWorker([], false);
      const request = fixture.request();
      yield* readResponse(yield* request.response);
      yield* drain(request.context);
      expect(fixture.sharedReleased).toEqual([]);
      return fixture;
    }).pipe(Effect.scoped);
    expect(worker.sharedReleased).toEqual([1]);
    expect(worker.released).toEqual([1]);
  }, Effect.provide(NodeServices.layer)),
);
