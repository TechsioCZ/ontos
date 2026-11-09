import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { OntosDeploymentIdentitySchema } from '@app/core-runtime';
import { NodeCrypto, NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node';
import { dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import type { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Config, Effect, FileSystem, Layer, Option, Predicate, Ref, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

class ProductOwnerChildUnavailable extends Schema.TaggedError<ProductOwnerChildUnavailable>()(
  'ProductOwnerChildUnavailable',
  {
    reason: Schema.String,
  },
) {}
const unavailable = () =>
  new ProductOwnerChildUnavailable({ reason: 'The actual C14 owner fixture receiver is unavailable' });

type CreateNativeHandler = ReturnType<typeof assembleEffectBffRuntime>['createHandler'];
const ownerModuleSchema = Schema.Struct({
  assembly: Schema.Struct({
    createHandler: Schema.declare<CreateNativeHandler>((value): value is CreateNativeHandler =>
      Predicate.isFunction(value),
    ),
  }),
  marker: OntosDeploymentIdentitySchema,
});
const publicProblemSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Int),
  title: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});
const outputSchema = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    problem: publicProblemSchema,
    status: Schema.Int,
    type: Schema.Literal('owner-http-problem'),
  }),
  Schema.Struct({ path: Schema.String, status: Schema.Int, type: Schema.Literal('committed-response-lost') }),
  Schema.Struct({ marker: OntosDeploymentIdentitySchema, port: Schema.Int, type: Schema.Literal('ready') }),
]);
const sendOutput = Effect.fn('SymmyC14ProductOwnerChild.output')(function* sendOutput(value: typeof outputSchema.Type) {
  const line = yield* Schema.encodeEffect(Schema.fromJsonString(outputSchema))(value);
  yield* Effect.sync(() => process.stdout.write(`${line}\n`));
});

const serve = Effect.scoped(
  Effect.gen(function* serveActualOwner() {
    const artifact = yield* Config.String('ONTOS_C14_OWNER_ARTIFACT');
    const prefix = yield* Config.schema(
      Schema.Literals([
        '/catalog-api',
        '/symmy-integration-api',
        '/pricing-api',
        '/party-registry-api',
        '/privacy-api',
        '/commerce-customer-context-api',
        '/price-group-catalog-api',
        '/inventory-api',
        '/commerce-market-catalog-api',
      ]),
      'ONTOS_C14_OWNER_PREFIX',
    );
    const port = yield* Config.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
      'ONTOS_C14_OWNER_PORT',
    );
    const owner = yield* Effect.tryPromise({
      catch: unavailable,
      try: async () => await Schema.decodeUnknownPromise(ownerModuleSchema)(await import(pathToFileURL(artifact).href)),
    });
    const app = yield* Effect.acquireRelease(
      Effect.try({ catch: unavailable, try: () => owner.assembly.createHandler() }),
      (handler) => Effect.promise(handler.dispose.bind(handler)),
    );
    const lost = yield* Ref.make(false);
    const faultMarker = yield* Config.option(Config.String('ONTOS_C14_RESPONSE_LOSS_MARKER'));
    const faultOperation = yield* Config.schema(
      Schema.Literals(['catalog-create-product', 'customer-group-create', 'inventory-import']),
      'ONTOS_C14_RESPONSE_LOSS_OPERATION',
    ).pipe(Config.withDefault('catalog-create-product'));
    const faultPaths = {
      'catalog-create-product': { read: '/reads/create-product-recovery', write: '/actions/create-product' },
      'customer-group-create': {
        read: '/reads/customer-group-definition-source',
        write: '/actions/create-customer-group',
      },
      'inventory-import': { read: '/reads/inventory-source-import-receipt', write: '/actions/import-source-assertion' },
    } as const;
    const faultPath = faultPaths[faultOperation];
    const traceProblems = yield* Config.Boolean('ONTOS_C14_TRACE_PROBLEMS').pipe(Config.withDefault(false));
    const fs = yield* FileSystem.FileSystem;
    const application = Effect.gen(function* actualOwnerRequest() {
      const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
      const path = new URL(request.url).pathname;
      const faultActive = Option.isSome(faultMarker) && (yield* fs.exists(faultMarker.value));
      // This is a test transport outage, never an owner acceptance or a replacement authorization gate.
      if (faultActive && path.endsWith(faultPath.read)) {
        return HttpServerResponse.empty({ status: 503 });
      }
      const response = yield* Effect.tryPromise({
        catch: unavailable,
        try: async () =>
          await dispatchEffectBffRequest(async (mounted) => await app.handler(mounted), request, { prefix }),
      });
      if (traceProblems && response.status >= 400) {
        const problem = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () => await Schema.decodeUnknownPromise(publicProblemSchema)(await response.clone().json()),
        }).pipe(Effect.option);
        if (Option.isSome(problem)) {
          yield* sendOutput({ path, problem: problem.value, status: response.status, type: 'owner-http-problem' });
        }
      }
      if (
        faultActive &&
        path.endsWith(faultPath.write) &&
        response.status >= 200 &&
        response.status < 300 &&
        !(yield* Ref.getAndSet(lost, true))
      ) {
        yield* sendOutput({ path, status: response.status, type: 'committed-response-lost' });
        return HttpServerResponse.empty({ status: 503 });
      }
      return HttpServerResponse.fromWeb(response);
    });
    yield* (yield* HttpServer.HttpServer).serve(application);
    yield* sendOutput({ marker: owner.marker, port, type: 'ready' });
    return yield* Effect.never;
  }),
);

const serverLayer = Layer.unwrap(
  Effect.gen(function* ownerServer() {
    const port = yield* Config.Number('ONTOS_C14_OWNER_PORT');
    return NodeHttpServer.layer(createServer, { host: '127.0.0.1', port });
  }),
);
NodeRuntime.runMain(serve.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, serverLayer))));
