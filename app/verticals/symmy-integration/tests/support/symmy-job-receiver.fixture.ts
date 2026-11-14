import { NodeHttpServer, NodeRuntime } from '@effect/platform-node';
import { dispatchEffectBffRequest } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';

import assembly from '../../api/index.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const prefix = '/symmy-integration-api';
const report = (value: string) => Effect.sync(() => process.stdout.write(`${value}\n`));

const serve = Effect.scoped(
  Effect.gen(function* serveSymmyJobReceiver() {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => assembly.createHandler()),
      (handler) => Effect.promise(async () => await handler.dispose()),
    );
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(
      Effect.gen(function* receiveSymmyJobRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.promise(
          async () =>
            await dispatchEffectBffRequest(async (mounted) => await runtime.handler(mounted), webRequest, { prefix }),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    );
    const { address } = server;
    if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
      return yield* Effect.die('The Symmy receiver fixture requires a loopback TCP address');
    }
    yield* report(JSON.stringify({ marker: ultramodernApiMarker, port: address.port }));
    return yield* Effect.never;
  }),
);

NodeRuntime.runMain(serve.pipe(Effect.provide(NodeHttpServer.layerTest)));
