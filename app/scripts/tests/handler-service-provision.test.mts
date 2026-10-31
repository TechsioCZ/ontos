import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { discoverApiRoots, findHandlerServiceGaps } from '../check-handler-service-provision.mts';

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
          reason:
            "HttpApiBuilder.group(api, 'actions', (handlers) => handlers.handle('act', () ... needs ActionPort, but no Layer on its composition path provides it",
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
