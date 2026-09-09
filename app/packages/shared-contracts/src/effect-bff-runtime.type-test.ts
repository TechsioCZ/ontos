import {
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeRequirements,
  HttpRouter,
} from '@modern-js/plugin-bff/effect-edge';
import { Context, Data, Schema } from 'effect';

import { assembleEffectBffRuntime } from './effect-bff-runtime.ts';

class FixtureDependency extends Context.Service<FixtureDependency, { readonly value: string }>()(
  '@app/shared-contracts/effect-bff-runtime.type-test/FixtureDependency',
) {}

const FixtureStartupError = Data.TaggedError('FixtureStartupError')<{
  readonly reason: string;
}>;

type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

type ExpectedRuntimeRequirements =
  | Exclude<
      EffectRuntimeRequirements,
      | HttpRouter.Request<'Error', unknown>
      | HttpRouter.Request<'GlobalError', unknown>
      | HttpRouter.Request<'GlobalRequires', unknown>
      | HttpRouter.Request<'Requires', unknown>
    >
  | HttpRouter.Request<'Requires', FixtureDependency>;

const fixtureApi = HttpApi.make('RuntimeAssemblyTypeFixture').add(
  HttpApiGroup.make('fixture').add(
    HttpApiEndpoint.get('read', '/fixture', {
      success: Schema.Struct({ value: Schema.String }),
    }),
  ),
);
const fixtureHandlers = HttpApiBuilder.group(fixtureApi, 'fixture', (handlers) =>
  handlers.handle('read', () => FixtureDependency.pipe(Effect.map(({ value }) => ({ value })))),
).pipe(Layer.provide(Layer.succeed(FixtureDependency, { value: 'fixture' })));

const fixtureRuntime = assembleEffectBffRuntime({
  api: fixtureApi,
  handlers: fixtureHandlers,
});

const concreteRuntime: EffectBffDefinition<typeof fixtureApi> & EffectBffRuntime<typeof fixtureApi> = fixtureRuntime;
const inferredApiIsExact: IsExact<typeof fixtureRuntime.api, typeof fixtureApi> = true;
const inferredRequirementsAreExact: IsExact<
  Layer.Services<typeof fixtureRuntime.layer>,
  ExpectedRuntimeRequirements
> = true;

void concreteRuntime;
void inferredApiIsExact;
void inferredRequirementsAreExact;

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
});
