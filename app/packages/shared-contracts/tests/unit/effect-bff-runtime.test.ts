// @effect-diagnostics asyncFunction:off -- Node test callbacks exercise the generated Web handler boundary; expires: 2027-03-31.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpRouter,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
} from '@modern-js/plugin-bff/effect-edge';
import { Context, Schema } from 'effect';

import { assembleEffectBffRuntime } from '../../src/effect-bff-runtime.ts';

class Greeting extends Context.Service<Greeting, { readonly value: string }>()(
  '@app/shared-contracts/tests/unit/effect-bff-runtime.test/Greeting'
) {}

const GreetingSchema = Schema.Struct({ greeting: Schema.String });
const api = HttpApi.make('AssemblyFixture').add(
  HttpApiGroup.make('fixture')
    .add(HttpApiEndpoint.get('greet', '/greet', { success: GreetingSchema }))
    .add(HttpApiEndpoint.get('fail', '/fail', { success: GreetingSchema }))
);
const handlers = HttpApiBuilder.group(api, 'fixture', (group) =>
  group
    .handle('greet', () =>
      Greeting.pipe(Effect.map(({ value }) => ({ greeting: value })))
    )
    .handle('fail', () => Effect.die('fixture handler defect'))
);

const makeRuntime = (greeting: string) =>
  assembleEffectBffRuntime({
    api,
    handlers: handlers.pipe(
      Layer.provide(Layer.succeed(Greeting, { value: greeting }))
    ),
  });

const makeCorsRuntime = (greeting: string) =>
  assembleEffectBffRuntime({
    api,
    handlers: handlers.pipe(
      Layer.provide(Layer.succeed(Greeting, { value: greeting }))
    ),
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
    Layer.provide(
      Layer.effect(Greeting, Effect.die('fixture layer startup defect'))
    )
  ),
});

const inferredRuntime: EffectBffDefinition<typeof api> &
  EffectBffRuntime<typeof api> = makeRuntime('compile-time fixture');
void inferredRuntime;

void test('assembles a concrete API with caller-provided handler dependencies', async () => {
  const server = makeRuntime('substitute runtime').createHandler();
  try {
    const response = await server.handler(
      new Request('http://localhost/greet')
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { greeting: 'substitute runtime' });
  } finally {
    await server.dispose();
  }
});

void test('keeps an optional caller-owned CORS layer in the assembled runtime', async () => {
  const server = makeCorsRuntime('with cors').createHandler();
  try {
    const response = await server.handler(
      new Request('http://localhost/greet', {
        headers: {
          'access-control-request-method': 'GET',
          origin: 'https://shell.example.test',
        },
        method: 'OPTIONS',
      })
    );
    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://shell.example.test'
    );
    assert.equal(response.headers.get('access-control-max-age'), '600');
  } finally {
    await server.dispose();
  }
});

void test('keeps strict runtime defect handling at the generated HTTP boundary', async () => {
  const server = makeRuntime('unused').createHandler();
  try {
    const response = await server.handler(new Request('http://localhost/fail'));
    assert.equal(response.status, 500);
  } finally {
    await server.dispose();
  }
});

void test('preserves caller-owned Layer startup defects', async () => {
  const server = failingStartupRuntime.createHandler();
  try {
    await assert.rejects(
      server.handler(new Request('http://localhost/greet')),
      /fixture layer startup defect/u
    );
  } finally {
    await server.dispose();
  }
});
