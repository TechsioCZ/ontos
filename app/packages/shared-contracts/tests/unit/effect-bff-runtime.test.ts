import { expect, it } from '@app/effect-rstest';

import {
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpRouter,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import { Context, Schema } from 'effect';

import { assembleEffectBffRuntime } from '../../src/effect-bff-runtime.ts';

class Greeting extends Context.Service<Greeting, { readonly value: string }>()(
  '@app/shared-contracts/tests/unit/effect-bff-runtime.test/Greeting',
) {}

const GreetingSchema = Schema.Struct({ greeting: Schema.String });
const api = HttpApi.make('AssemblyFixture').add(
  HttpApiGroup.make('fixture')
    .add(HttpApiEndpoint.get('greet', '/greet', { success: GreetingSchema }))
    .add(HttpApiEndpoint.get('fail', '/fail', { success: GreetingSchema })),
);
const handlers = HttpApiBuilder.group(api, 'fixture', (group) =>
  group
    .handle('greet', () => Greeting.pipe(Effect.map(({ value }) => ({ greeting: value }))))
    .handle('fail', () => Effect.die('fixture handler defect')),
);

const makeRuntime = (greeting: string) =>
  assembleEffectBffRuntime({
    api,
    handlers: handlers.pipe(Layer.provide(Layer.succeed(Greeting, { value: greeting }))),
  });

const makeCorsRuntime = (greeting: string) =>
  assembleEffectBffRuntime({
    api,
    handlers: handlers.pipe(Layer.provide(Layer.succeed(Greeting, { value: greeting }))),
    transport: HttpRouter.cors({
      allowedHeaders: ['content-type'],
      allowedMethods: ['GET', 'OPTIONS'],
      allowedOrigins: ['https://shell.example.test'],
      maxAge: 600,
    }),
  });

const failingStartupRuntime = assembleEffectBffRuntime({
  api,
  handlers: handlers.pipe(
    Layer.provide(Layer.effect(Greeting, Effect.die('fixture layer startup defect'))),
  ),
});

const inferredRuntime: EffectBffDefinition<typeof api> & EffectBffRuntime<typeof api> =
  makeRuntime('compile-time fixture');
void inferredRuntime;

it.live('assembles a concrete API with caller-provided handler dependencies', () =>
  Effect.gen(function* assembleRuntimeEffect() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => makeRuntime('substitute runtime').createHandler()),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(new Request('http://localhost/greet')),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({
      greeting: 'substitute runtime',
    });
  }),
);

it.live('keeps an optional caller-owned CORS layer in the assembled runtime', () =>
  Effect.gen(function* corsRuntimeEffect() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => makeCorsRuntime('with cors').createHandler()),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(
        new Request('http://localhost/greet', {
          headers: {
            'access-control-request-method': 'GET',
            origin: 'https://shell.example.test',
          },
          method: 'OPTIONS',
        }),
      ),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://shell.example.test');
    expect(response.headers.get('access-control-max-age')).toBe('600');
  }),
);

it.live('keeps strict runtime defect handling at the generated HTTP boundary', () =>
  Effect.gen(function* runtimeDefectEffect() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => makeRuntime('unused').createHandler()),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const response = yield* Effect.promise(() =>
      server.handler(new Request('http://localhost/fail')),
    );
    expect(response.status).toBe(500);
  }),
);

it.live('preserves caller-owned Layer startup defects', () =>
  Effect.gen(function* startupDefectEffect() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => failingStartupRuntime.createHandler()),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const error = yield* Effect.tryPromise(() =>
      server.handler(new Request('http://localhost/greet')),
    ).pipe(Effect.flip);
    expect(String(error.cause)).toMatch(/fixture layer startup defect/u);
  }),
);
