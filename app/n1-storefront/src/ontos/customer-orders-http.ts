import "server-only";
import { Effect, Layer, ManagedRuntime, Match } from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  CustomerOrdersAnonymousProblem,
  CustomerOrdersApi,
  CustomerOrdersForbiddenProblem,
  CustomerOrdersInvalidProblem,
  CustomerOrdersProblemSchema,
  CustomerOrdersResultSchema,
  CustomerOrdersSchemaErrorMiddleware,
  CustomerOrdersUnavailableProblem,
} from "./customer-orders";
import { readCustomerOrders } from "./customer-orders-server";
import type { CustomerOrdersFailure } from "./customer-orders-server";
import { portalRequestContext } from "./portal-server";
import { normalizePublicRequest } from "./request-origin";

const details = {
  detail: "Customer orders could not be read.",
  title: "Customer orders",
  type: "urn:n1:customer-orders",
};
const problemContentType = "application/problem+json";
const invalidProblem = () =>
  CustomerOrdersInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const toProblem = (error: CustomerOrdersFailure) =>
  Match.value(error.state).pipe(
    Match.when("invalid", invalidProblem),
    Match.when("anonymous", () =>
      CustomerOrdersAnonymousProblem.make({ ...details, state: "anonymous", status: 401 }),
    ),
    Match.when("forbidden", () =>
      CustomerOrdersForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
    ),
    Match.when("unavailable", () =>
      CustomerOrdersUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
    ),
    Match.exhaustive,
  );
const responsePolicy = (response: HttpServerResponse.HttpServerResponse) =>
  response.pipe(
    HttpServerResponse.setHeaders({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    }),
  );
const failureResponse = (state: "invalid" | "forbidden" | "unavailable") =>
  Match.value(state).pipe(
    Match.when("invalid", () =>
      HttpServerResponse.schemaJson(CustomerOrdersInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when("forbidden", () =>
      HttpServerResponse.schemaJson(CustomerOrdersForbiddenProblem)(
        CustomerOrdersForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when("unavailable", () =>
      HttpServerResponse.schemaJson(CustomerOrdersUnavailableProblem)(
        CustomerOrdersUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.exhaustive,
    Effect.orDie,
    Effect.map(responsePolicy),
  );
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  CustomerOrdersSchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);
const handlers = HttpApiBuilder.group(CustomerOrdersApi, "customerOrders", (group) =>
  group.handle("list", ({ query, request }) =>
    Effect.gen(function* customerOrdersChannel() {
      const context = portalRequestContext(
        new URL(request.originalUrl).origin,
        request.headers.cookie,
      );
      const response = yield* readCustomerOrders(query, context).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const problem = toProblem(error);
            return HttpServerResponse.schemaJson(CustomerOrdersProblemSchema)(problem, {
              contentType: problemContentType,
              status: problem.status,
            });
          },
          onSuccess: (data) => HttpServerResponse.schemaJson(CustomerOrdersResultSchema)(data),
        }),
        Effect.orDie,
      );
      return response.pipe(
        HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies)),
      );
    }),
  ),
).pipe(Layer.provide(schemaErrors));
const application = Layer.merge(
  HttpApiBuilder.layer(CustomerOrdersApi),
  HttpRouter.middleware((effect) => effect.pipe(Effect.map(responsePolicy)), { global: true }),
).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
  ),
);
export const customerOrdersWeb = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (effect) =>
    Effect.gen(function* guardCustomerOrdersRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const actual = new URL(request.originalUrl);
      const { origin } = request.headers;
      const fetchSite = request.headers["sec-fetch-site"];
      if (
        (origin !== undefined && URL.parse(origin)?.origin !== actual.origin) ||
        (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")
      ) {
        return yield* failureResponse("forbidden");
      }
      const allowed = new Set(["locale", "offset", "orderId"]);
      if (
        actual.search.length > 2048 ||
        [...actual.searchParams.keys()].some(
          (key) => !allowed.has(key) || actual.searchParams.getAll(key).length !== 1,
        )
      ) {
        return yield* failureResponse("invalid");
      }
      return yield* effect;
    }).pipe(
      Effect.timeoutOrElse({
        duration: "45 seconds",
        orElse: () => failureResponse("unavailable"),
      }),
      Effect.map(responsePolicy),
    ),
});
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const customerOrdersHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () => failureResponse("invalid").pipe(Effect.map(HttpServerResponse.toWeb)),
        onSuccess: (normalized) =>
          Effect.promise(async () => await customerOrdersWeb.handler(normalized)),
      }),
    ),
  );
