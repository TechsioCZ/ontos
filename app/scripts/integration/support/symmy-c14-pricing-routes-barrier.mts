import { createServer } from 'node:http';

import { DefinePricePayloadSchema, DefinePriceResultSchema } from '@app/pricing/actions/define-price';
import { PriceSourceAssertionDependencySchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { NodeHttpServer } from '@effect/platform-node';
import { Context, Deferred, Effect, Layer, Option, Ref, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

const unavailable = () =>
  new SymmyC14ProductFixtureUnavailable({ message: 'The owned first-Price transport barrier is unavailable' });

/** Test transport only: separately hold one Price for ACK loss and another for route deactivation. */
export const installInternalC14PriceDispatchBarrier = Effect.fn('InternalC14PricingRoutes.barrier')(
  function* installBarrier(input: { readonly port: number; readonly targetOrigin: string }) {
    const target = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:\d+$/u)),
    )(input.targetOrigin);
    const httpServer = createServer();
    const server = Context.get(
      yield* Layer.build(NodeHttpServer.layer(() => httpServer, { host: '127.0.0.1', port: input.port })),
      HttpServer.HttpServer,
    );
    const arrived = yield* Deferred.make<typeof DefinePricePayloadSchema.Type>();
    const committedReplyLost =
      yield* Deferred.make<
        Extract<typeof DefinePriceResultSchema.Type, { readonly outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED' }>
      >();
    const released = yield* Deferred.make<boolean>();
    const revocationArrived = yield* Deferred.make<typeof DefinePricePayloadSchema.Type>();
    const revocationReleased = yield* Deferred.make<boolean>();
    const revocationReply = yield* Deferred.make<{ readonly code?: string; readonly status: number }>();
    const revocationPriceId = yield* Ref.make(Option.none<string>());
    const intercepted = yield* Ref.make(false);
    const armedPriceCommandCount = yield* Ref.make(0);
    const sourceReceiptReads = yield* Ref.make(0);
    const diagnostic = yield* Ref.make('none');
    const armedPriceId = yield* Ref.make(Option.none<string>());
    const application = Effect.gen(function* forwardActualPricingRequest() {
      const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest);
      const path = new URL(request.url);
      const armed = yield* Ref.get(armedPriceId);
      const revoke = yield* Ref.get(revocationPriceId);
      let loseAcceptedReply = false;
      let holdForRevocation = false;
      if (path.pathname.endsWith('/reads/price-source-result-lookup')) {
        yield* Ref.update(sourceReceiptReads, (count) => count + 1);
      }
      if (path.pathname.endsWith('/actions/define-price') && (Option.isSome(armed) || Option.isSome(revoke))) {
        const payload = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () => await Schema.decodeUnknownPromise(DefinePricePayloadSchema)(await request.clone().json()),
        });
        if (Option.isSome(armed) && payload.priceRef.resourceId === armed.value) {
          yield* Ref.update(armedPriceCommandCount, (count) => count + 1);
          if (!(yield* Ref.getAndSet(intercepted, true))) {
            loseAcceptedReply = true;
            yield* Deferred.succeed(arrived, payload);
            if (!(yield* Deferred.await(released))) {
              return HttpServerResponse.empty({ status: 503 });
            }
          }
        }
        if (Option.isSome(revoke) && payload.priceRef.resourceId === revoke.value) {
          holdForRevocation = yield* Deferred.succeed(revocationArrived, payload);
          if (holdForRevocation && !(yield* Deferred.await(revocationReleased))) {
            return HttpServerResponse.empty({ status: 503 });
          }
        }
      }
      const response = yield* Effect.tryPromise({
        catch: (cause) => {
          const parsed = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String, name: Schema.String }))(
            cause,
          );
          return new SymmyC14ProductFixtureUnavailable({
            message:
              Option.isSome(parsed) && parsed.value.message.includes('duplex')
                ? 'The native first-Price transport requires Request duplex'
                : 'The native first-Price transport request failed',
          });
        },
        try: async () => {
          const forwarded = new Request(`${target}${path.pathname}${path.search}`, request);
          // Hop-by-hop transport headers are recreated by Fetch; end-to-end headers and body stay unchanged.
          for (const name of [
            'connection',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
            'te',
            'trailer',
            'transfer-encoding',
            'upgrade',
          ]) {
            forwarded.headers.delete(name);
          }
          return await fetch(forwarded);
        },
      }).pipe(
        Effect.tapError((error) => Ref.set(diagnostic, error.message)),
        Effect.tap((reply) =>
          path.pathname.endsWith('/actions/define-price')
            ? Effect.tryPromise({
                catch: unavailable,
                try: async () =>
                  await Schema.decodeUnknownPromise(
                    Schema.Struct({
                      code: Schema.optionalKey(Schema.String),
                      dependency: Schema.optionalKey(PriceSourceAssertionDependencySchema),
                      outcome: Schema.optionalKey(Schema.String),
                    }),
                  )(await reply.clone().json()),
              }).pipe(
                Effect.flatMap((metadata) =>
                  Ref.set(
                    diagnostic,
                    `HTTP ${reply.status}; outcome: ${metadata.outcome ?? 'unavailable'}; dependency: ${metadata.dependency ?? 'unavailable'}; code: ${metadata.code ?? 'unavailable'}`,
                  ),
                ),
                Effect.catch(() => Ref.set(diagnostic, `The native Price reply HTTP ${reply.status} was not JSON`)),
              )
            : Effect.void,
        ),
      );
      if (holdForRevocation) {
        const problem = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () =>
            await Schema.decodeUnknownPromise(Schema.Struct({ code: Schema.optionalKey(Schema.String) }))(
              await response.clone().json(),
            ),
        }).pipe(Effect.catch(() => Effect.succeed({})));
        yield* Deferred.succeed(revocationReply, { ...problem, status: response.status });
      }
      if (loseAcceptedReply && response.status === 200) {
        const assessment = yield* Effect.tryPromise({
          catch: unavailable,
          try: async () => await Schema.decodeUnknownPromise(DefinePriceResultSchema)(await response.clone().json()),
        });
        if (assessment.outcome === 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED') {
          yield* Deferred.succeed(committedReplyLost, assessment);
          // The real owner has committed; only its successful transport ACK is deliberately lost.
          return HttpServerResponse.empty({ status: 503 });
        }
      }
      return HttpServerResponse.fromWeb(response);
    });
    yield* server.serve(application);
    // This runs before the server shutdown waits for open requests. Abandon any held
    // request on fixture exit without forwarding it after a failed assertion.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* closeBarrier() {
        yield* Deferred.succeed(released, false);
        yield* Deferred.succeed(revocationReleased, false);
        httpServer.closeAllConnections();
      }),
    );
    return {
      armedPriceCommandCount: Ref.get(armedPriceCommandCount),
      armForPrice: (priceId: string) =>
        Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(priceId).pipe(
          Effect.flatMap((id) => Ref.set(armedPriceId, Option.some(id))),
        ),
      arrived: Deferred.await(arrived),
      committedReplyLost: Deferred.await(committedReplyLost),
      diagnostic: Ref.get(diagnostic),
      release: Deferred.succeed(released, true),
      revocation: {
        armForPrice: (priceId: string) =>
          Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(priceId).pipe(
            Effect.flatMap((id) => Ref.set(revocationPriceId, Option.some(id))),
          ),
        arrived: Deferred.await(revocationArrived),
        release: Deferred.succeed(revocationReleased, true),
        reply: Deferred.await(revocationReply),
      },
      sourceReceiptReads: Ref.get(sourceReceiptReads),
    };
  },
);
