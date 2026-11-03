import "server-only";
import { ByteSize, Effect, Layer, ManagedRuntime, Match } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerError,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  CartQuoteApi,
  CartQuoteForbiddenProblem,
  CartQuoteInvalidProblem,
  CartQuoteSchemaErrorMiddleware,
  CartQuoteScopeProblem,
  CartQuoteUnavailableProblem,
} from "./cart-quote";
import type { CartQuoteFailure } from "./cart-quote-server";
import { quoteCart } from "./cart-quote-server";
import { normalizePublicRequest } from "./request-origin";

const maxBodyBytes = 65_536;
const noStore = HttpServerResponse.setHeader("cache-control", "no-store");
const problemContentType = "application/problem+json";
const details = {
  detail: "Cart quote could not be confirmed.",
  title: "Cart quote",
  type: "urn:n1:cart-quote",
};
const invalidProblem = () =>
  CartQuoteInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const toProblem = (error: CartQuoteFailure) =>
  Match.value(error.state).pipe(
    Match.when("invalid", invalidProblem),
    Match.when("forbidden", () =>
      CartQuoteForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
    ),
    Match.when("scope-mismatch", () =>
      CartQuoteScopeProblem.make({ ...details, state: "scope-mismatch", status: 409 }),
    ),
    Match.when("unavailable", () =>
      CartQuoteUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
    ),
    Match.exhaustive,
  );
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  CartQuoteSchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);
const handlers = HttpApiBuilder.group(CartQuoteApi, "cartQuote", (group) =>
  group.handle("quote", ({ payload }) => quoteCart(payload).pipe(Effect.mapError(toProblem))),
).pipe(Layer.provide(schemaErrors));
const failureResponse = (state: "invalid" | "forbidden" | "unavailable") =>
  Match.value(state).pipe(
    Match.when("invalid", () =>
      HttpServerResponse.schemaJson(CartQuoteInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when("forbidden", () =>
      HttpServerResponse.schemaJson(CartQuoteForbiddenProblem)(
        CartQuoteForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when("unavailable", () =>
      HttpServerResponse.schemaJson(CartQuoteUnavailableProblem)(
        CartQuoteUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.exhaustive,
    Effect.orDie,
    Effect.map(noStore),
  );
const finalizeResponse = (response: HttpServerResponse.HttpServerResponse) =>
  (response.status === 413 ? failureResponse("invalid") : Effect.succeed(response)).pipe(
    Effect.map(noStore),
  );
const responsePolicy = HttpRouter.middleware(
  (effect) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        HttpServerError.isHttpServerError(defect)
          ? Match.value(defect.reason).pipe(
              Match.tag("RequestParseError", () => failureResponse("invalid")),
              Match.orElse(() => Effect.die(defect)),
            )
          : Effect.die(defect),
      ),
      Effect.flatMap(finalizeResponse),
    ),
  { global: true },
);
const application = Layer.merge(HttpApiBuilder.layer(CartQuoteApi), responsePolicy).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
  ),
  Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBodyBytes))),
);
export const cartQuoteWeb = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (effect) =>
    Effect.gen(function* guardCartQuoteRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const origin = URL.parse(request.headers.origin ?? "");
      const actual = new URL(request.originalUrl);
      if (origin === null || origin.origin !== actual.origin) {
        return yield* failureResponse("forbidden");
      }
      const length = request.headers["content-length"];
      if (
        actual.search !== "" ||
        !/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "") ||
        (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBodyBytes))
      ) {
        return yield* failureResponse("invalid");
      }
      return yield* effect;
    }).pipe(
      Effect.timeoutOrElse({
        duration: "55 seconds",
        orElse: () => failureResponse("unavailable"),
      }),
      Effect.map(noStore),
    ),
});
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const cartQuoteHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () => failureResponse("invalid").pipe(Effect.map(HttpServerResponse.toWeb)),
        onSuccess: (normalized) =>
          Effect.promise(async () => await cartQuoteWeb.handler(normalized)),
      }),
    ),
  );
