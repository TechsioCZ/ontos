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
  CheckoutApi,
  CheckoutForbiddenProblem,
  CheckoutInvalidProblem,
  CheckoutSchemaErrorMiddleware,
  CheckoutScopeProblem,
  CheckoutUnavailableProblem,
  CheckoutUncertainProblem,
} from "./checkout";
import type { CheckoutFailure } from "./checkout-server";
import { recoverCheckout, submitCheckout } from "./checkout-server";
import { normalizePublicRequest } from "./request-origin";

const maxBodyBytes = 65_536;
const noStore = HttpServerResponse.setHeader("cache-control", "no-store");
const problemContentType = "application/problem+json";
const details = {
  detail: "Checkout could not be confirmed.",
  title: "Checkout",
  type: "urn:n1:checkout",
};
const invalidProblem = () =>
  CheckoutInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const toProblem = (error: CheckoutFailure) =>
  Match.value(error.state).pipe(
    Match.when("invalid", invalidProblem),
    Match.when("forbidden", () =>
      CheckoutForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
    ),
    Match.when("scope-mismatch", () =>
      CheckoutScopeProblem.make({ ...details, state: "scope-mismatch", status: 409 }),
    ),
    Match.when("unavailable", () =>
      CheckoutUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
    ),
    Match.when("uncertain", () =>
      CheckoutUncertainProblem.make({ ...details, state: "uncertain", status: 503 }),
    ),
    Match.exhaustive,
  );
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  CheckoutSchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);
const handlers = HttpApiBuilder.group(CheckoutApi, "checkout", (group) =>
  group
    .handle("execute", ({ payload }) => submitCheckout(payload).pipe(Effect.mapError(toProblem)))
    .handle("status", ({ payload }) => recoverCheckout(payload).pipe(Effect.mapError(toProblem))),
).pipe(Layer.provide(schemaErrors));
const failureResponse = (state: "invalid" | "forbidden" | "uncertain") =>
  Match.value(state).pipe(
    Match.when("invalid", () =>
      HttpServerResponse.schemaJson(CheckoutInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when("forbidden", () =>
      HttpServerResponse.schemaJson(CheckoutForbiddenProblem)(
        CheckoutForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when("uncertain", () =>
      HttpServerResponse.schemaJson(CheckoutUncertainProblem)(
        CheckoutUncertainProblem.make({ ...details, state: "uncertain", status: 503 }),
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
const application = Layer.merge(HttpApiBuilder.layer(CheckoutApi), responsePolicy).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
  ),
  Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBodyBytes))),
);
export const checkoutWeb = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (effect) =>
    Effect.gen(function* guardCheckoutRequest() {
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
      // A timeout may occur after native dispatch. Never imply that another order can safely be sent.
      Effect.timeoutOrElse({ duration: "55 seconds", orElse: () => failureResponse("uncertain") }),
      Effect.map(noStore),
    ),
});
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const checkoutHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () => failureResponse("invalid").pipe(Effect.map(HttpServerResponse.toWeb)),
        onSuccess: (normalized) =>
          Effect.promise(async () => await checkoutWeb.handler(normalized)),
      }),
    ),
  );
