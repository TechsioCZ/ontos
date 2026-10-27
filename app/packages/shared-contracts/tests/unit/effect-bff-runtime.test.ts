import {
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpRouter,
  Layer,
} from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Context, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';

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

const assembleFixtureRuntime = assembleEffectBffRuntime<
  typeof api.identifier,
  typeof api.groups.fixture,
  Layer.Services<typeof handlers>,
  Greeting,
  HttpRouter.HttpRouter
>;

const makeRuntime = (greeting: string) =>
  assembleFixtureRuntime({
    api,
    handlers,
    services: Layer.succeed(Greeting, { value: greeting }),
  });

const makeCorsRuntime = (greeting: string) =>
  assembleFixtureRuntime({
    api,
    handlers,
    services: Layer.succeed(Greeting, { value: greeting }),
    transport: HttpRouter.cors({
      allowedHeaders: ['content-type'],
      allowedMethods: ['GET', 'OPTIONS'],
      allowedOrigins: ['https://shell.example.test'],
      maxAge: 600,
    }),
  });

const failingStartupRuntime = assembleFixtureRuntime({
  api,
  handlers,
  services: Layer.effect(Greeting, Effect.die('fixture layer startup defect')),
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
    const response = yield* Effect.promise(() => server.handler(new Request('http://localhost/greet')));
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
    const response = yield* Effect.promise(() => server.handler(new Request('http://localhost/fail')));
    expect(response.status).toBe(500);
  }),
);

it.live('preserves caller-owned Layer startup defects', () =>
  Effect.gen(function* startupDefectEffect() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => failingStartupRuntime.createHandler()),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    const error = yield* Effect.tryPromise(() => server.handler(new Request('http://localhost/greet'))).pipe(
      Effect.flip,
    );
    expect(String(error.cause)).toMatch(/fixture layer startup defect/u);
  }),
);

it.live('builds the services for every request when the edge asks for request lifetime', () =>
  Effect.gen(function* requestServicesEffect() {
    let builds = 0;
    const runtime = assembleFixtureRuntime({
      api,
      handlers,
      services: Layer.effect(
        Greeting,
        Effect.sync(() => {
          builds += 1;
          return { value: `request ${builds}` };
        }),
      ),
    });
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.createHandler({ servicesLifetime: 'request' })),
      (runtimeServer) => Effect.promise(() => runtimeServer.dispose()),
    );
    yield* Effect.promise(() => server.ready ?? Promise.resolve());
    const greet = () =>
      Effect.promise(() => server.handler(new Request('http://localhost/greet')).then((response) => response.json()));
    expect(yield* greet()).toEqual({ greeting: 'request 1' });
    expect(yield* greet()).toEqual({ greeting: 'request 2' });
    expect(builds).toBe(2);
  }),
);
