import "server-only";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { CardVariantsApi } from "./card-variants";
import { readCardVariants } from "./card-variants-server";

const handlers = HttpApiBuilder.group(CardVariantsApi, "cardVariants", (group) =>
  group.handle("read", ({ query }) => readCardVariants(query)),
);
const responsePolicy = HttpRouter.middleware(
  (effect) =>
    effect.pipe(Effect.map(HttpServerResponse.setHeaders({ "cache-control": "no-store" }))),
  { global: true },
);
export const cardVariantsWeb = HttpRouter.toWebHandler(
  Layer.merge(HttpApiBuilder.layer(CardVariantsApi), responsePolicy).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);
