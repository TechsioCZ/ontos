// @effect-diagnostics strictEffectProvide:off -- Native proof receiver fixture is the process entrypoint that composes its layers once; expires: 2027-03-31.
import { inspect } from 'node:util';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { defineEffectBff } from '@modern-js/bff-effect/effect-edge';
import { Cause, Config, Effect, Exit, Layer, Redacted, Schema, Tracer } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import apiRuntime from '../../api/index.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { pricingMarkerSchema } from '../../shared/api.ts';

class PricingFinalizationReceiverFailure extends Schema.TaggedError<PricingFinalizationReceiverFailure>()(
  'PricingFinalizationReceiverFailure',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}

/**
 * Test-only observation of the default runtime's own spans: the first failure of each selected span writes its
 * duration and complete Cause to stderr, which the parent redacts and shows only when the proof fails. A 503 Problem
 * carries no cause, so this is how a failed proof tells which Pricing authority refused and after how long.
 */
const makeSelectedFailureTracer = (selected: ReadonlySet<string>): Tracer.Tracer => {
  const reported = new Set<string>();
  return Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        if (Exit.isSuccess(exit) || !selected.has(span.name) || reported.has(span.name)) {
          return;
        }
        reported.add(span.name);
        const elapsedMilliseconds = (endTime - span.startTime) / 1_000_000n;
        const diagnostic = `${span.name} failed after ${elapsedMilliseconds} ms\n${Cause.pretty(exit.cause)}\n${inspect(exit.cause, { colors: false, customInspect: false, depth: 8, maxStringLength: null })}`;
        process.stderr.write(`${diagnostic}\n`);
      };
      return span;
    },
  });
};

const describe = Schema.encodeEffect(Schema.fromJsonString(pricingMarkerSchema))(ultramodernApiMarker).pipe(
  Effect.flatMap((line) => Effect.sync(() => process.stdout.write(`${line}\n`))),
);
const serve = Effect.scoped(
  Effect.gen(function* serveActualPricingFinalizationReceiver() {
    const selected = yield* Config.String('ONTOS_PREPROPOSAL_PRICING_FAILURE_SPANS').pipe(Config.withDefault(''));
    const spans = new Set(selected.split(',').filter((name) => name.length > 0));
    const observed =
      spans.size === 0
        ? apiRuntime
        : defineEffectBff({
            ...apiRuntime,
            layer: apiRuntime.layer.pipe(Layer.provide(Layer.succeed(Tracer.Tracer, makeSelectedFailureTracer(spans)))),
          });
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => observed.createHandler()),
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
