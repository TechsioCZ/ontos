import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  createEffectBffEdgeDispatcher,
  createEffectOperationContext,
} from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Exit, Layer, Schema, Stream } from 'effect';
import { forEach } from 'effect/Effect';
import { HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

interface RequestResourceValue {
  readonly id: number;
  readonly isOpen: () => boolean;
}

class RequestResource extends Context.Service<RequestResource, RequestResourceValue>()(
  'app/scripts/tests/bff-request-services-compatibility.test/RequestResource',
) {}

const READ_URL = 'https://fixture.invalid/read';
const ResourceResponse = Schema.Struct({ id: Schema.Finite, open: Schema.Boolean });
const FixtureApi = HttpApi.make('RequestServicesCompatibility').add(
  HttpApiGroup.make('fixture')
    .add(HttpApiEndpoint.get('read', '/read', { success: ResourceResponse }))
    .add(HttpApiEndpoint.get('stream', '/stream', { success: Schema.String }))
    .add(HttpApiEndpoint.get('defect', '/defect', { success: ResourceResponse }))
    .add(HttpApiEndpoint.head('empty', '/empty', { success: Schema.Void })),
);

const fixtureHandlers = HttpApiBuilder.group(FixtureApi, 'fixture', (handlers) =>
  handlers
    .handle('read', () =>
      RequestResource.pipe(Effect.map((resource) => ({ id: resource.id, open: resource.isOpen() }))),
    )
    .handleRaw('stream', () =>
      RequestResource.pipe(
        Effect.map((resource) =>
          HttpServerResponse.stream(
            Stream.make(new TextEncoder().encode(String(resource.id))).pipe(Stream.concat(Stream.never)),
          ),
        ),
      ),
    )
    .handle('defect', () => RequestResource.pipe(Effect.andThen(Effect.die('controlled request-handler defect'))))
    .handle('empty', () => RequestResource.pipe(Effect.asVoid)),
);

const makeFixture = () => {
  const acquired: number[] = [];
  const released: number[] = [];
  const jobs: Promise<unknown>[] = [];
  const services = Layer.effect(
    RequestResource,
    Effect.acquireRelease(
      Effect.sync(() => {
        const id = acquired.length + 1;
        let open = true;
        acquired.push(id);
        return {
          close: () => {
            open = false;
            released.push(id);
          },
          id,
          isOpen: () => open,
        };
      }),
      (resource) => Effect.sync(resource.close),
    ),
  );
  const runtime = assembleEffectBffRuntime({ api: FixtureApi, handlers: fixtureHandlers, services });
  const request = new Request(READ_URL);
  const context = {
    env: {},
    method: 'GET',
    operationContext: createEffectOperationContext({ env: {}, method: 'GET', path: '/read', request }),
    path: '/read',
    request,
    waitUntil: (job: Promise<unknown>) => {
      jobs.push(job);
    },
  };
  return { acquired, context, jobs, released, runtime, services };
};

const makeHandler = Effect.fn(function* makeHandler(
  fixture: ReturnType<typeof makeFixture>,
  servicesLifetime: 'handler' | 'request' = 'request',
) {
  const handler = yield* Effect.acquireRelease(
    Effect.sync(() => fixture.runtime.createHandler({ servicesLifetime })),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );
  yield* Effect.promise(() => handler.ready ?? Promise.resolve());
  return handler;
});

const readResponse = Effect.fn(function* readResponse(response: Response) {
  expect(response.status).toBe(200);
  return yield* Schema.decodeUnknownEffect(ResourceResponse)(yield* Effect.promise(() => response.json()));
});

it.live(
  'native service-free assemblies remain valid without a services placeholder',
  Effect.fn(function* nativeServiceFreeAssembly() {
    const api = HttpApi.make('NativeServiceFreeCompatibility').add(
      HttpApiGroup.make('fixture').add(HttpApiEndpoint.get('read', '/read', { success: ResourceResponse })),
    );
    const handlers = HttpApiBuilder.group(api, 'fixture', (group) =>
      group.handle('read', () => Effect.succeed({ id: 0, open: true })),
    );
    const runtime = assembleEffectBffRuntime({ api, handlers });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.createHandler({ servicesLifetime: 'request' })),
      (value) => Effect.promise(() => value.dispose()),
    );
    const response = yield* Effect.promise(() => handler.handler(new Request(READ_URL)));
    expect(yield* readResponse(response)).toEqual({ id: 0, open: true });
  }, Effect.scoped),
);

it.live(
  'one real HTTP handler acquires and releases distinct services for sequential requests',
  Effect.fn(function* sequentialRequests() {
    const fixture = makeFixture();
    const handler = yield* makeHandler(fixture);
    expect(fixture.acquired).toEqual([]);
    for (const id of [1, 2]) {
      const response = yield* Effect.promise(() => handler.handler(new Request(READ_URL), fixture.context));
      expect(yield* readResponse(response)).toEqual({ id, open: true });
      yield* Effect.promise(() => Promise.all(fixture.jobs));
      expect(fixture.released).toEqual(fixture.acquired);
    }
  }, Effect.scoped),
);

it.live(
  'concurrent requests do not share request resources or their finalizers',
  Effect.fn(function* concurrentRequests() {
    const fixture = makeFixture();
    const handler = yield* makeHandler(fixture);
    const responses = yield* Effect.promise(() =>
      Promise.all([1, 2, 3].map(() => handler.handler(new Request(READ_URL), fixture.context))),
    );
    const values = yield* forEach(responses, readResponse);
    yield* Effect.promise(() => Promise.all(fixture.jobs));
    expect(new Set(values.map(({ id }) => id))).toEqual(new Set([1, 2, 3]));
    expect(values.every(({ open }) => open)).toBe(true);
    expect(new Set(fixture.released)).toEqual(new Set(fixture.acquired));
    expect(fixture.released).toHaveLength(3);
  }, Effect.scoped),
);

it.live(
  'streaming keeps the request resource open until the response body is canceled',
  Effect.fn(function* streamingCancellation() {
    const fixture = makeFixture();
    const handler = yield* makeHandler(fixture);
    const response = yield* Effect.promise(() =>
      handler.handler(new Request('https://fixture.invalid/stream'), fixture.context),
    );
    expect(response.status).toBe(200);
    const reader = yield* Effect.fromNullishOr(response.body?.getReader());
    const chunk = yield* Effect.promise(() => reader.read());
    expect(new TextDecoder().decode(chunk.value)).toBe('1');
    expect(fixture.released).toEqual([]);
    yield* Effect.promise(() => reader.cancel());
    yield* Effect.promise(() => Promise.all(fixture.jobs));
    expect(fixture.released).toEqual([1]);
  }, Effect.scoped),
);

it.live(
  'disposing a handler closes abandoned request resources even without waitUntil',
  Effect.fn(function* abandonedResponse() {
    const fixture = makeFixture();
    const handler = yield* makeHandler(fixture);
    const response = yield* Effect.promise(() => handler.handler(new Request('https://fixture.invalid/stream')));
    expect(response.status).toBe(200);
    expect(fixture.acquired).toEqual([1]);
    expect(fixture.released).toEqual([]);
    yield* Effect.promise(() => handler.dispose());
    expect(fixture.released).toEqual([1]);
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
    expect(fixture.released).toEqual([1]);
  }, Effect.scoped),
);

it.live(
  'null-body responses and handler defects release their own request services',
  Effect.fn(function* terminalResponses() {
    const fixture = makeFixture();
    const handler = yield* makeHandler(fixture);
    const empty = yield* Effect.promise(() =>
      handler.handler(new Request('https://fixture.invalid/empty', { method: 'HEAD' }), fixture.context),
    );
    expect(empty.body).toBeNull();
    yield* Effect.promise(() => Promise.all(fixture.jobs));
    expect(fixture.released).toEqual([1]);
    const failed = yield* Effect.promise(() =>
      handler.handler(new Request('https://fixture.invalid/defect'), fixture.context),
    );
    expect(failed.status).toBe(500);
    yield* Effect.promise(() => failed.arrayBuffer());
    yield* Effect.promise(() => Promise.all(fixture.jobs));
    expect(fixture.released).toEqual([1, 2]);
  }, Effect.scoped),
);

it.live(
  'a failed service build closes resources acquired before the failure',
  Effect.fn(function* failedServiceBuild() {
    const fixture = makeFixture();
    const services = Layer.effect(
      RequestResource,
      Layer.build(fixture.services).pipe(Effect.andThen(Effect.die('controlled service-acquisition defect'))),
    );
    const runtime = assembleEffectBffRuntime({ api: FixtureApi, handlers: fixtureHandlers, services });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.createHandler({ servicesLifetime: 'request' })),
      (value) => Effect.promise(() => value.dispose()),
    );
    const outcome = yield* Effect.exit(Effect.promise(() => handler.handler(new Request(READ_URL), fixture.context)));
    expect(Exit.isFailure(outcome)).toBe(true);
    yield* Effect.promise(() => handler.dispose());
    expect(fixture.acquired).toEqual([1]);
    expect(fixture.released).toEqual([1]);
  }, Effect.scoped),
);

it.live(
  'Node keeps handler-lifetime services until the handler is disposed',
  Effect.fn(function* nodeHandlerLifetime() {
    const fixture = makeFixture();
    const handler = yield* makeHandler(fixture, 'handler');
    for (const _request of [1, 2]) {
      const response = yield* Effect.promise(() => handler.handler(new Request(READ_URL)));
      expect(yield* readResponse(response)).toEqual({ id: 1, open: true });
    }
    expect(fixture.acquired).toEqual([1]);
    expect(fixture.released).toEqual([]);
    yield* Effect.promise(() => handler.dispose());
    expect(fixture.released).toEqual([1]);
  }, Effect.scoped),
);

it.live(
  'the native edge dispatcher forwards the service lifetime and cleanup scheduler',
  Effect.fn(function* edgeDispatcherLifetime() {
    const fixture = makeFixture();
    const dispatcher = yield* Effect.acquireRelease(
      Effect.promise(() => createEffectBffEdgeDispatcher({ module: fixture.runtime })),
      (value) => Effect.promise(() => value.dispose()),
    );
    for (const id of [1, 2]) {
      const response = yield* Effect.promise(() =>
        dispatcher.dispatch(new Request(READ_URL), {
          waitUntil: (job) => {
            fixture.jobs.push(job);
          },
        }),
      );
      expect(yield* readResponse(response)).toEqual({ id, open: true });
      yield* Effect.promise(() => Promise.all(fixture.jobs));
    }
    expect(fixture.released).toEqual([1, 2]);
  }, Effect.scoped),
);
