import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { discoverApiRoots, findHandlerServiceGaps } from '../check-handler-service-provision.mts';

const missingActionPortReason =
  "HttpApiBuilder.group(api, 'actions', (handlers) => handlers.handle('act', () ... needs ActionPort, but no Layer on its composition path provides it";
const appRoot = path.resolve(import.meta.dirname, '../..');
const API_ROOT = 'verticals/fixture/api/index.ts';

// Dependencies resolve from the app's node_modules, so the fixture workspace lives in its cache directory.
const fixtureWorkspace = (files: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const cache = path.join(appRoot, 'node_modules/.cache');
      await mkdir(cache, { recursive: true });
      const root = await mkdtemp(path.join(cache, 'handler-service-provision-'));
      await Promise.all(
        Object.entries(files).map(async ([file, content]) => {
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), content);
        }),
      );
      return root;
    }),
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
  );

const fixtureTsconfig = JSON.stringify({
  compilerOptions: {
    allowImportingTsExtensions: true,
    module: 'preserve',
    moduleResolution: 'bundler',
    noEmit: true,
    strict: true,
    target: 'esnext',
    types: [],
  },
  include: ['api'],
});

const fixtureApi = `import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, Layer } from '@modern-js/bff-effect/effect-edge';
import { Context, Schema } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';

class ReadPort extends Context.Service<ReadPort, { readonly value: string }>()('fixture/ReadPort') {}
class ActionPort extends Context.Service<ActionPort, { readonly value: string }>()('fixture/ActionPort') {}
class RoutePort extends Context.Service<RoutePort, { readonly value: string }>()('fixture/RoutePort') {}

const api = HttpApi.make('Fixture')
  .add(HttpApiGroup.make('reads').add(HttpApiEndpoint.get('read', '/read', { success: Schema.String })))
  .add(HttpApiGroup.make('actions').add(HttpApiEndpoint.get('act', '/act', { success: Schema.String })));

const readsLive = HttpApiBuilder.group(api, 'reads', (handlers) =>
  handlers.handle('read', () => ReadPort.pipe(Effect.map(({ value }) => value))),
);
const actionsLive = HttpApiBuilder.group(api, 'actions', (handlers) =>
  handlers.handle('act', () => Effect.all([ReadPort, ActionPort]).pipe(Effect.map(([read]) => read.value))),
);
const readPortLive = Layer.succeed(ReadPort, { value: 'read' });

// The parameter declares nothing; the Layer the root passes for it provides ReadPort.
export const makeFixtureRuntime = (...args: readonly [runtime: Layer.Layer<never>]) => {
  const [runtimeLive] = args;
  const handlersLive = Layer.mergeAll(
    readsLive.pipe(Layer.provide(runtimeLive)),
    actionsLive.pipe(Layer.provide(readPortLive)),
  );
  return assembleEffectBffRuntime({
    api,
    handlers: handlersLive,
    transport: HttpRouter.add('GET', '/route', RoutePort.pipe(Effect.as(HttpServerResponse.text('route')))),
  });
};

export default makeFixtureRuntime(readPortLive);
`;

it.live(
  'reports each handler group service and transport request requirement that no Layer on its path provides',
  () =>
    Effect.gen(function* testEffect() {
      const root = yield* fixtureWorkspace({
        [API_ROOT]: fixtureApi,
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      expect(yield* discoverApiRoots(root)).toEqual([API_ROOT]);
      const gaps = yield* findHandlerServiceGaps(root, [API_ROOT]);
      expect(gaps.map(({ file, reason }) => ({ file, reason }))).toEqual([
        {
          file: API_ROOT,
          reason: missingActionPortReason,
        },
        {
          file: API_ROOT,
          reason: 'transport routes need RoutePort per request, but no route middleware provides it',
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);

it.live(
  'passes once every handler group service is provided on its composition path',
  () =>
    Effect.gen(function* testEffect() {
      const root = yield* fixtureWorkspace({
        [API_ROOT]: fixtureApi
          .replace(
            'Layer.provide(readPortLive)),\n  );',
            "Layer.provide(readPortLive), Layer.provide(Layer.succeed(ActionPort, { value: 'act' }))),\n  );",
          )
          .replace(/\n {4}transport: .*\n/u, '\n'),
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      expect(yield* findHandlerServiceGaps(root, [API_ROOT])).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);

it.live(
  'reads the Layers a root passes through a spread runtime-argument tuple',
  () =>
    Effect.gen(function* testEffect() {
      const root = yield* fixtureWorkspace({
        [API_ROOT]: fixtureApi.replace(
          'export default makeFixtureRuntime(readPortLive);',
          'const runtimeArguments = Object.freeze([readPortLive] as const);\nexport default makeFixtureRuntime(...runtimeArguments);',
        ),
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      const gaps = yield* findHandlerServiceGaps(root, [API_ROOT]);
      // ReadPort reaches the reads group through the spread tuple; only the genuine gaps remain.
      expect(gaps.map(({ reason }) => reason)).toEqual([
        missingActionPortReason,
        'transport routes need RoutePort per request, but no route middleware provides it',
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);

const runnerFixtureApi = (
  runtimeBody: string,
) => `import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, Layer } from '@modern-js/bff-effect/effect-edge';
import { Context, Schema } from 'effect';

class ActionPort extends Context.Service<ActionPort, { readonly value: string }>()('fixture/ActionPort') {}
interface RunnerService {
  readonly runAction: <A, E, R>(input: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
class Runner extends Context.Service<Runner, RunnerService>()('fixture/Runner') {}

const api = HttpApi.make('Fixture').add(
  HttpApiGroup.make('actions').add(HttpApiEndpoint.get('act', '/act', { success: Schema.String })),
);
const actionsLive = HttpApiBuilder.group(api, 'actions', (handlers) =>
  handlers.handle('act', () =>
    Runner.pipe(Effect.flatMap((runner) => runner.runAction(ActionPort.pipe(Effect.map(({ value }) => value))))),
  ),
);
const base: RunnerService = { runAction: (input) => input };
const other = Effect.succeed('other');
const runnerLive = Layer.effect(
  Runner,
  Effect.sync((): RunnerService => ({
    runAction: (input) => ${runtimeBody},
  })),
);

export const makeFixtureRuntime = (...args: readonly [runner: Layer.Layer<Runner>]) => {
  const [runner] = args;
  return assembleEffectBffRuntime({ api, handlers: actionsLive.pipe(Layer.provide(runner)) });
};

export default makeFixtureRuntime(runnerLive);
`;

it.live(
  'counts a service the runtime binds around the Action invocation it forwards',
  () =>
    Effect.gen(function* testEffect() {
      const root = yield* fixtureWorkspace({
        [API_ROOT]: runnerFixtureApi(
          "base.runAction(input).pipe(Effect.provideService(ActionPort, { value: 'act' })) as never",
        ),
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      expect(yield* findHandlerServiceGaps(root, [API_ROOT])).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);

it.live(
  'does not borrow per-invocation services from another runtime for a caller-owned runtime',
  () =>
    Effect.gen(function* testEffect() {
      const source = runnerFixtureApi(
        "base.runAction(input).pipe(Effect.provideService(ActionPort, { value: 'act' })) as never",
      );
      const root = yield* fixtureWorkspace({
        [API_ROOT]: `${source}\nexport const fromContext = Effect.gen(function* () {
          const runtime = yield* Runner;
          return makeFixtureRuntime(Layer.succeed(Runner, runtime));
        });`,
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      const gaps = yield* findHandlerServiceGaps(root, [API_ROOT]);
      expect(gaps.some(({ reason }) => reason.includes('needs ActionPort'))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);

it.live(
  'does not count a service provided to an unused copy of the received Action invocation',
  () =>
    Effect.gen(function* testEffect() {
      const root = yield* fixtureWorkspace({
        [API_ROOT]: runnerFixtureApi(`{
          const unused = base.runAction(input).pipe(Effect.provideService(ActionPort, { value: 'act' }));
          return base.runAction(input);
        }`),
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      const gaps = yield* findHandlerServiceGaps(root, [API_ROOT]);
      expect(gaps.some(({ reason }) => reason.includes('needs ActionPort'))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);

it.live(
  'does not count a service bound only around an Action run the runtime starts for itself',
  () =>
    Effect.gen(function* testEffect() {
      const root = yield* fixtureWorkspace({
        [API_ROOT]: runnerFixtureApi(
          "base.runAction(other).pipe(Effect.provideService(ActionPort, { value: 'act' }), Effect.andThen(base.runAction(input))) as never",
        ),
        'verticals/fixture/tsconfig.json': fixtureTsconfig,
      });
      const gaps = yield* findHandlerServiceGaps(root, [API_ROOT]);
      expect(gaps.map(({ reason }) => reason)).toEqual([missingActionPortReason]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
