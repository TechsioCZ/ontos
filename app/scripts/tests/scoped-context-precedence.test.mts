import { Context, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/http-api';

const factoryValueSchema = Schema.Literals(['root', 'fake', 'request']);
type FactoryValue = typeof factoryValueSchema.Type;
interface FactoryProbeService {
  readonly make: () => FactoryValue;
}
const FactoryProbe = Context.Service<FactoryProbeService>('@app/tooling/tests/scoped-context-precedence/FactoryProbe');
type FactoryProbeRequirement = Context.Service.Identifier<typeof FactoryProbe>;
class TaggedFactoryOverride extends HttpApiMiddleware.Service<
  TaggedFactoryOverride,
  { provides: FactoryProbeRequirement; requires: FactoryProbeRequirement }
>()('@app/tooling/tests/scoped-context-precedence/TaggedFactoryOverride') {}

const rootFactoryContext = Context.make(FactoryProbe, { make: () => 'root' });
const rootFactory = Layer.succeedContext(rootFactoryContext);
const fakeFactoryContext = Context.make(FactoryProbe, { make: () => 'fake' });
const requestFactoryContext = Context.make(FactoryProbe, { make: () => 'request' });
const resultSchema = Schema.Struct({ factory: factoryValueSchema });
const localResultSchema = Schema.Struct({ beforeFactory: factoryValueSchema, factory: factoryValueSchema });
const readFactory = Effect.gen(function* readFactoryFromCurrentContext() {
  const factory = yield* FactoryProbe;
  return { factory: factory.make() };
});
const plainGroup = HttpApiGroup.make('plain').add(
  HttpApiEndpoint.get('readRoot', '/factory-root', { success: resultSchema }),
  HttpApiEndpoint.get('readLocal', '/factory-local', { success: localResultSchema }),
);
const plainApi = HttpApi.make('scoped-context-precedence-plain').add(plainGroup);
const plainHandlers = HttpApiBuilder.group(plainApi, 'plain', (group) =>
  group
    .handle('readRoot', () => readFactory)
    .handle('readLocal', () =>
      Effect.gen(function* localOwnerProvision() {
        const before = yield* FactoryProbe;
        const inside = yield* readFactory.pipe(Effect.provideContext(fakeFactoryContext));
        return { beforeFactory: before.make(), factory: inside.factory };
      }),
    ),
).pipe(Layer.provide(rootFactory));
const plainRoutes = HttpApiBuilder.layer(plainApi).pipe(
  Layer.provide(plainHandlers),
  Layer.provide(HttpServer.layerServices),
);
const globalOverride = HttpRouter.middleware(
  (incoming) =>
    Effect.gen(function* globalProvision() {
      const supplied = yield* FactoryProbe;
      const response = yield* incoming;
      return response.pipe(HttpServerResponse.setHeader('x-factory-global-context', supplied.make()));
    }).pipe(Effect.provideContext(fakeFactoryContext)),
  { global: true },
);
const taggedGroup = HttpApiGroup.make('tagged')
  .add(HttpApiEndpoint.get('readTagged', '/factory-tagged', { success: resultSchema }))
  .middleware(TaggedFactoryOverride);
const taggedApi = HttpApi.make('scoped-context-precedence-tagged').add(taggedGroup);
const taggedMiddleware = Layer.succeed(TaggedFactoryOverride)((incoming) =>
  Effect.gen(function* taggedProvision() {
    const before = yield* FactoryProbe;
    const response = yield* incoming.pipe(Effect.provideContext(fakeFactoryContext));
    return response.pipe(HttpServerResponse.setHeader('x-factory-before-tagged-provision', before.make()));
  }),
);
const taggedHandlers = HttpApiBuilder.group(taggedApi, 'tagged', (group) =>
  group.handle('readTagged', () => readFactory),
).pipe(Layer.provide(Layer.mergeAll(rootFactory, taggedMiddleware)));
const taggedRoutes = HttpApiBuilder.layer(taggedApi).pipe(
  Layer.provide(taggedHandlers),
  Layer.provide(HttpServer.layerServices),
);
const serverFor = (
  routes: Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request.From<'Requires', FactoryProbeRequirement>
  >,
) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    (server) => Effect.promise(() => server.dispose()),
  );

it.live('outer global HttpRouter provision loses to the native HttpApiBuilder captured group context', () =>
  Effect.gen(function* outerGlobalContextPrecedence() {
    const server = yield* serverFor(Layer.mergeAll(plainRoutes, globalOverride));
    const response = yield* Effect.promise(() =>
      server.handler(new Request('https://precedence.ontos.test/factory-root'), requestFactoryContext),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-factory-global-context')).toBe('fake');
    const text = yield* Effect.promise(() => response.text());
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(resultSchema))(text);
    expect(result.factory).toBe('root');
  }),
);

it.live('tagged HttpApiMiddleware inner provision overrides the native captured root factory', () =>
  Effect.gen(function* taggedContextPrecedence() {
    const server = yield* serverFor(taggedRoutes);
    const response = yield* Effect.promise(() =>
      server.handler(new Request('https://precedence.ontos.test/factory-tagged'), requestFactoryContext),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-factory-before-tagged-provision')).toBe('root');
    const text = yield* Effect.promise(() => response.text());
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(resultSchema))(text);
    expect(result.factory).toBe('fake');
  }),
);

it.live('local owner provision around a contextual Factory yield overrides the captured root factory', () =>
  Effect.gen(function* localOwnerContextPrecedence() {
    const server = yield* serverFor(plainRoutes);
    const response = yield* Effect.promise(() =>
      server.handler(new Request('https://precedence.ontos.test/factory-local'), requestFactoryContext),
    );
    expect(response.status).toBe(200);
    const text = yield* Effect.promise(() => response.text());
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(localResultSchema))(text);
    expect(result.beforeFactory).toBe('root');
    expect(result.factory).toBe('fake');
  }),
);
