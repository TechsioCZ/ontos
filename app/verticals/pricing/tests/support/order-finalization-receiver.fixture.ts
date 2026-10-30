// @effect-diagnostics strictEffectProvide:off -- Native proof receiver fixture is the process entrypoint that composes its layers once; expires: 2027-03-31.
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Effect, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import apiRuntime from '../../api/index.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { pricingMarkerSchema } from '../../shared/api.ts';

class PricingFinalizationReceiverFailure extends Schema.TaggedError<PricingFinalizationReceiverFailure>()(
  'PricingFinalizationReceiverFailure',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

const describe = Schema.encodeEffect(Schema.fromJsonString(pricingMarkerSchema))(ultramodernApiMarker).pipe(
  Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))),
);
const serve = Effect.scoped(
  Effect.gen(function* serveActualPricingFinalizationReceiver() {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => apiRuntime.createHandler()),
      (handler) => Effect.promise(handler.dispose.bind(handler)),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* forwardUnchangedDefaultRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: (cause) =>
            new PricingFinalizationReceiverFailure({
              cause: Redacted.make(cause),
              reason: 'The default Pricing Order finalization HTTP adapter failed',
            }),
          try: runtime.handler.bind(runtime, webRequest, undefined),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Int.check(Schema.isGreaterThan(0)) }))(address)) {
      return yield* new PricingFinalizationReceiverFailure({ reason: 'A loopback receiver address is required' });
    }
    const line = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          marker: pricingMarkerSchema,
          port: Schema.Int.check(Schema.isGreaterThan(0)),
          type: Schema.Literal('ready'),
        }),
      ),
    )({ marker: ultramodernApiMarker, port: address.port, type: 'ready' });
    yield* Effect.sync(() => process.stdout.write(`${line}\n`));
    return yield* Effect.never;
  }),
);

const main = process.argv.includes('--describe') ? describe : serve;
NodeRuntime.runMain(main.pipe(Effect.provide(NodeHttpServer.layerTest)));
