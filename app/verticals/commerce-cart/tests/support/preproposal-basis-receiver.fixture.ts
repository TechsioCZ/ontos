import { parseDatabaseConfig } from '@app/core-runtime';
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { Config, Effect, Redacted, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const protocol = 'ontos.cart.preproposal-basis.receiver.v1' as const;

class PreproposalCartReceiverUnavailable extends Schema.TaggedError<PreproposalCartReceiverUnavailable>()(
  'PreproposalCartReceiverUnavailable',
  { stage: Schema.String },
) {}

const unavailable = (stage: string) => new PreproposalCartReceiverUnavailable({ stage });

const describe = Effect.sync(() =>
  process.stdout.write(
    `${JSON.stringify({
      marker: ultramodernApiMarker,
      operations: [
        'initialize-population-authority',
        'create-cart-draft',
        'revise-cart-draft',
        'preapproval-cart-observation',
      ],
      protocol,
      type: 'description',
    })}\n`,
  ),
);

/**
 * Closed owner executable: all handlers, registration, policies and persistence stay in Cart.
 * The parent supplies its isolated runtime configuration and uses published HTTP clients only.
 * No business setup, assertion substitution or grant override is installed by this receiver.
 */
const serve = Effect.scoped(
  Effect.gen(function* servePreproposalCart() {
    const connection = yield* Config.Redacted('DATABASE_URL');
    const database = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connection) });
    if (
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(database.host) ||
      !/^ontos_test_[a-z0-9_]+$/u.test(database.database) ||
      database.user !== 'ontos_runtime'
    ) {
      return yield* unavailable('isolated-runtime-database');
    }
    // Importing this fixture or describing its protocol never constructs the owner runtime.
    const { default: apiRuntime } = yield* Effect.tryPromise({
      catch: () => unavailable('owner-runtime-import'),
      try: async () => await import('../../api/index.ts'),
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => apiRuntime.createHandler()),
      (runtime) => Effect.promise(async () => await runtime.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* forwardPublicCartRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise({
          catch: () => unavailable('owner-http-adapter'),
          try: async () => await handler.handler(web),
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const address = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ port: Schema.Int.check(Schema.isGreaterThan(0)) }),
    )(server.address);
    yield* Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({ marker: ultramodernApiMarker, port: address.port, protocol, type: 'ready' })}\n`,
      ),
    );
    return yield* Effect.never;
  }),
);

if (process.argv.includes('--describe-preproposal-basis')) {
  NodeRuntime.runMain(describe);
} else if (process.argv.includes('--serve-preproposal-basis')) {
  NodeRuntime.runMain(serve.pipe(Effect.provide(NodeHttpServer.layerTest)));
}
