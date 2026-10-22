import {
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  Layer,
} from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Context, Data, Schema } from 'effect';

import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';

class FixtureDependency extends Context.Service<FixtureDependency, { readonly value: string }>()(
  '@app/shared-contracts/effect-bff-runtime.type-test/FixtureDependency',
) {}

const FixtureStartupError = Data.TaggedError('FixtureStartupError')<{
  readonly reason: string;
}>;

type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

const fixtureApi = HttpApi.make('RuntimeAssemblyTypeFixture').add(
  HttpApiGroup.make('fixture').add(
    HttpApiEndpoint.get('read', '/fixture', {
      success: Schema.Struct({ value: Schema.String }),
    }),
  ),
);
const fixtureHandlers = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) =>
  handlers.handle('read', () => FixtureDependency.pipe(Effect.map(({ value }) => ({ value })))),
);
const fixtureServices = Layer.succeed(FixtureDependency, { value: 'fixture' });

const fixtureRuntime = assembleEffectBffRuntime({
  api: fixtureApi,
  handlers: fixtureHandlers,
  services: fixtureServices,
});

// @ts-expect-error Every service a handler resolves must come from `services`.
assembleEffectBffRuntime({
  api: fixtureApi,
  handlers: fixtureHandlers,
  services: Layer.empty,
});

assembleEffectBffRuntime({
  api: fixtureApi,
  handlers: fixtureHandlers,
  // @ts-expect-error Request services must not fail; startup failures are handled at the owner runtime root.
  services: Layer.effect(FixtureDependency, Effect.fail(new FixtureStartupError({ reason: 'unhandled' }))),
});

const concreteRuntime: EffectBffDefinition<typeof fixtureApi> & EffectBffRuntime<typeof fixtureApi> = fixtureRuntime;
const inferredApiIsExact: IsExact<typeof fixtureRuntime.api, typeof fixtureApi> = true;

void concreteRuntime;
void inferredApiIsExact;

const failingFixtureHandlers = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) =>
  handlers.handle('read', () => Effect.succeed({ value: 'unreachable' })),
).pipe(
  Layer.provide(
    Layer.effect(
      FixtureDependency,
      Effect.fail(
        new FixtureStartupError({
          reason: 'must be resolved at the runtime root',
        }),
      ),
    ),
  ),
);

assembleEffectBffRuntime({
  api: fixtureApi,
  // @ts-expect-error Startup layer failures must be handled at the owner runtime root.
  handlers: failingFixtureHandlers,
  services: fixtureServices,
});

const otherApi = HttpApi.make('OtherRuntimeAssemblyTypeFixture').add(
  HttpApiGroup.make('other').add(
    HttpApiEndpoint.get('readOther', '/other', {
      success: Schema.Struct({ value: Schema.String }),
    }),
  ),
);

assembleEffectBffRuntime({
  api: otherApi,
  // @ts-expect-error Handler services must belong to the exact concrete HttpApi contract.
  handlers: fixtureHandlers,
  services: fixtureServices,
});
