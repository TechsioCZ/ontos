import { constUndefined } from "effect/Function";
import type { OperationError } from "@ontos/storefront-runtime";
import { actionMayHaveDispatched, storefrontHttpClientLayer, ownerHttp } from "./owner-operation";
import "server-only";
import { ByteSize, Context, Effect, Layer, ManagedRuntime, Match, Schema } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerError,
  HttpServerResponse,
  Cookies,
  HttpEffect,
} from "effect/http";
import type { HttpClient } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  CheckoutApi,
  CheckoutForbiddenProblem,
  CheckoutInvalidProblem,
  CheckoutSchemaErrorMiddleware,
  CheckoutScopeProblem,
  CheckoutUnavailableProblem,
  CheckoutUncertainProblem,
  CheckoutResultSchema,
  CheckoutRecoverySchema,
} from "./checkout";
import type { CheckoutFailure } from "./checkout-server";
import { recoverCheckout, submitCheckout } from "./checkout-server";
import { normalizePublicRequest } from "./request-origin";
import { portalRequestContext } from "./portal-server";
import type { PortalRequestContext } from "./portal-server";

const CheckoutChannelRequest = Context.Reference<PortalRequestContext | undefined>(
  "n1/CheckoutChannelRequest",
  {
    defaultValue: constUndefined,
  },
);

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
const toProblem = (
  error: CheckoutFailure | OperationError | Schema.SchemaError,
  canCommit: boolean,
  dispatched: boolean,
) =>
  Match.value(
    Match.value(error).pipe(
      Match.tag("OperationError", () =>
        canCommit && dispatched ? ("uncertain" as const) : ("unavailable" as const),
      ),
      Match.tag("SchemaError", () => "unavailable" as const),
      Match.tag("CheckoutFailure", (failure) =>
        failure.state === "uncertain" && (!canCommit || !dispatched)
          ? ("unavailable" as const)
          : failure.state,
      ),
      Match.exhaustive,
    ),
  ).pipe(
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
const problems = Schema.Union([
  CheckoutInvalidProblem,
  CheckoutForbiddenProblem,
  CheckoutScopeProblem,
  CheckoutUnavailableProblem,
  CheckoutUncertainProblem,
]);
const channel = (
  _channelRequest: HttpServerRequest.HttpServerRequest,
  program: (
    context: PortalRequestContext,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    CheckoutFailure | OperationError | Schema.SchemaError,
    HttpClient.HttpClient
  >,
  canCommit: boolean,
) =>
  Effect.gen(function* checkoutChannel() {
    const context = yield* CheckoutChannelRequest;
    if (context === undefined) {
      return yield* Effect.die(new Error("Missing Checkout request boundary"));
    }
    // Native request-owned response hooks survive an interrupted dispatch and the outer timeout reply.
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        response.pipe(HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies))),
      ),
    );
    const response = yield* program(context).pipe(
      Effect.catch((error) =>
        Effect.gen(function* checkoutProblem() {
          const problem = toProblem(error, canCommit, yield* actionMayHaveDispatched);
          return yield* HttpServerResponse.schemaJson(problems)(problem, {
            contentType: problemContentType,
            status: problem.status,
          }).pipe(Effect.orDie);
        }),
      ),
    );
    return response;
  });
const checkoutResultResponse = (data: typeof CheckoutResultSchema.Type) =>
  HttpServerResponse.schemaJson(CheckoutResultSchema)(data).pipe(Effect.orDie);
const checkoutRecoveryResponse = (data: typeof CheckoutRecoverySchema.Type) =>
  HttpServerResponse.schemaJson(CheckoutRecoverySchema)(data).pipe(Effect.orDie);
type CheckoutService<F> = F extends (
  ...args: infer Args
) => Effect.Effect<infer A, infer E, infer R>
  ? (...args: Args) => Effect.Effect<A, E | OperationError | Schema.SchemaError, R>
  : never;
const makeHandlers = (
  submit: CheckoutService<typeof submitCheckout>,
  recover: CheckoutService<typeof recoverCheckout>,
) =>
  HttpApiBuilder.group(CheckoutApi, "checkout", (group) =>
    group
      .handle("execute", ({ payload, request }) =>
        channel(
          request,
          (context) => submit(payload, context).pipe(Effect.flatMap(checkoutResultResponse)),
          payload.mode === "place",
        ),
      )
      .handle("status", ({ payload, request }) =>
        channel(
          request,
          (context) => recover(payload, context).pipe(Effect.flatMap(checkoutRecoveryResponse)),
          false,
        ),
      ),
  ).pipe(Layer.provide(schemaErrors));
const failureResponse = (state: "invalid" | "forbidden" | "uncertain" | "unavailable") =>
  Match.value(state).pipe(
    Match.when("invalid", () =>
      HttpServerResponse.schemaJson(CheckoutInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when("unavailable", () =>
      HttpServerResponse.schemaJson(CheckoutUnavailableProblem)(
        CheckoutUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
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
const operationalFailureResponse = actionMayHaveDispatched.pipe(
  Effect.flatMap((dispatched) => failureResponse(dispatched ? "uncertain" : "unavailable")),
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
      // This deadline returns through native response sending, so pre-response cookie hooks run.
      Effect.timeoutOrElse({
        duration: "55 seconds",
        orElse: () => operationalFailureResponse,
      }),
      Effect.flatMap(finalizeResponse),
    ),
  { global: true },
);
export const makeCheckoutWeb = ({
  recover = recoverCheckout,
  submit = submitCheckout,
}: {
  recover?: CheckoutService<typeof recoverCheckout>;
  submit?: CheckoutService<typeof submitCheckout>;
} = {}) => {
  const application = Layer.merge(HttpApiBuilder.layer(CheckoutApi), responsePolicy).pipe(
    Layer.provide(makeHandlers(submit, recover)),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(storefrontHttpClientLayer),
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
    ),
    Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBodyBytes))),
  );
  return HttpRouter.toWebHandler(application, {
    disableLogger: true,
    middleware: (effect) =>
      Effect.gen(function* checkoutRequestBoundary() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const context = portalRequestContext(
          new URL(request.originalUrl).origin,
          request.headers.cookie,
        );
        return yield* ownerHttp(
          Effect.gen(function* guardCheckoutRequest() {
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
          }).pipe(Effect.map(noStore)),
          // Only a dispatched placing Action can leave an unknown mutation outcome.
          () =>
            operationalFailureResponse.pipe(
              Effect.orDie,
              Effect.map(noStore),
              Effect.map(
                HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies)),
              ),
            ),
        ).pipe(Effect.updateService(CheckoutChannelRequest, () => context));
      }),
  });
};
export const checkoutWeb = makeCheckoutWeb();
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
