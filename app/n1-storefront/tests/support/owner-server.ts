import { NodeHttpServer } from "@effect/platform-node";
import type { InProcessApplication } from "@app/shared-contracts/testing/http-double";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

/** Server-edge tests use Node's complete Fetch family, with a scoped owner on a real loopback origin. */
export const ownerServer = (
  application: InProcessApplication,
  environment: Readonly<Record<string, string>>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* configureOwnerOrigin() {
      const server = yield* HttpServer.HttpServer;
      const origin = new URL(HttpServer.formatAddress(server.address));
      origin.hostname = "127.0.0.1";
      const config = {
        ...environment,
        ONTOS_SHELL_URL: origin.origin,
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Object.keys(config).map((key) => [key, process.env[key]] as const);
          Object.assign(process.env, config);
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            for (const [key, value] of previous) {
              if (value === undefined) {
                Reflect.deleteProperty(process.env, key);
              } else {
                process.env[key] = value;
              }
            }
          }),
      );
    }),
  ).pipe(
    Layer.provide(
      HttpRouter.serve(application, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ),
  );
