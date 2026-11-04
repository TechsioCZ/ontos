import "server-only";
import { ByteSize, Effect, Layer, ManagedRuntime, Match } from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  CustomerProfileApi,
  CustomerProfileAuthenticationProblem,
  CustomerProfileConflictProblem,
  CustomerProfileForbiddenProblem,
  CustomerProfileInvalidProblem,
  CustomerProfileReadSchema,
  CustomerProfileSchemaErrorMiddleware,
  CustomerProfileUnavailableProblem,
  CustomerProfileUnconfirmedProblem,
} from "./customer-profile";
import type { CustomerProfileRead } from "./customer-profile";
import { readCustomerProfile, updateCustomerProfile } from "./customer-profile-server";
import type { CustomerProfileFailure } from "./customer-profile-server";
import { portalRequestContext } from "./portal-server";
import type { PortalRequestContext } from "./portal-server";
import { isPortalOrigin } from "./portal-model";
import { normalizePublicRequest } from "./request-origin";

const maxBodyBytes = 16_384;
const problemContentType = "application/problem+json";
const noStore = HttpServerResponse.setHeaders({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});
const details = {
  detail: "Customer profile request could not be completed.",
  title: "Customer profile",
  type: "urn:n1:customer-profile",
};
const invalidProblem = () =>
  CustomerProfileInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const responseForFailure = (state: CustomerProfileFailure["state"]) =>
  Match.value(state).pipe(
    Match.when("invalid", () =>
      HttpServerResponse.schemaJson(CustomerProfileInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when("anonymous", () =>
      HttpServerResponse.schemaJson(CustomerProfileAuthenticationProblem)(
        CustomerProfileAuthenticationProblem.make({ ...details, state: "anonymous", status: 401 }),
        { contentType: problemContentType, status: 401 },
      ),
    ),
    Match.when("forbidden", () =>
      HttpServerResponse.schemaJson(CustomerProfileForbiddenProblem)(
        CustomerProfileForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when("conflict", () =>
      HttpServerResponse.schemaJson(CustomerProfileConflictProblem)(
        CustomerProfileConflictProblem.make({ ...details, state: "conflict", status: 409 }),
        { contentType: problemContentType, status: 409 },
      ),
    ),
    Match.when("unavailable", () =>
      HttpServerResponse.schemaJson(CustomerProfileUnavailableProblem)(
        CustomerProfileUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.when("unconfirmed", () =>
      HttpServerResponse.schemaJson(CustomerProfileUnconfirmedProblem)(
        CustomerProfileUnconfirmedProblem.make({ ...details, state: "unconfirmed", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.exhaustive,
    Effect.orDie,
    Effect.map(noStore),
  );
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  CustomerProfileSchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);
type ProfileProgram =
  | ReturnType<typeof readCustomerProfile>
  | ReturnType<typeof updateCustomerProfile>;
const channel = (
  request: HttpServerRequest.HttpServerRequest,
  program: (
    context: PortalRequestContext,
  ) => Effect.Effect<CustomerProfileRead, CustomerProfileFailure, Effect.Services<ProfileProgram>>,
) =>
  Effect.gen(function* customerProfileChannel() {
    const context = portalRequestContext(
      new URL(request.originalUrl).origin,
      request.headers.cookie,
    );
    const response = yield* program(context).pipe(
      Effect.matchEffect({
        onFailure: (error) => responseForFailure(error.state),
        onSuccess: (value) =>
          HttpServerResponse.schemaJson(CustomerProfileReadSchema)(value).pipe(Effect.orDie),
      }),
    );
    return response.pipe(
      noStore,
      HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies)),
    );
  });
const handlers = HttpApiBuilder.group(CustomerProfileApi, "customerProfile", (group) =>
  group
    .handle("read", ({ request }) => channel(request, readCustomerProfile))
    .handle("update", ({ payload, request }) =>
      channel(request, (context) => updateCustomerProfile(payload, context)),
    ),
).pipe(Layer.provide(schemaErrors));
const responsePolicy = HttpRouter.middleware(
  (effect) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        HttpServerError.isHttpServerError(defect)
          ? Match.value(defect.reason).pipe(
              Match.tag("RequestParseError", () => responseForFailure("invalid")),
              Match.orElse(() => Effect.die(defect)),
            )
          : Effect.die(defect),
      ),
      Effect.flatMap((response) =>
        response.status === 413 ? responseForFailure("invalid") : Effect.succeed(response),
      ),
      Effect.map(noStore),
    ),
  { global: true },
);
const application = Layer.merge(HttpApiBuilder.layer(CustomerProfileApi), responsePolicy).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
  ),
  Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBodyBytes))),
);
export const customerProfileWeb = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (effect) =>
    Effect.gen(function* guardCustomerProfileRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        (request.method !== "GET" || request.headers.origin !== undefined) &&
        !isPortalOrigin(request.headers.origin, request.originalUrl)
      ) {
        return yield* responseForFailure("forbidden");
      }
      const url = new URL(request.originalUrl);
      const length = request.headers["content-length"];
      if (
        url.search !== "" ||
        (request.method !== "GET" &&
          (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "") ||
            (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBodyBytes))))
      ) {
        return yield* responseForFailure("invalid");
      }
      return yield* effect.pipe(
        Effect.timeoutOrElse({
          duration: "55 seconds",
          orElse: () =>
            responseForFailure(request.method === "GET" ? "unavailable" : "unconfirmed"),
        }),
      );
    }).pipe(Effect.map(noStore)),
});
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const customerProfileHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () => responseForFailure("invalid").pipe(Effect.map(HttpServerResponse.toWeb)),
        onSuccess: (normalized) =>
          Effect.promise(async () => await customerProfileWeb.handler(normalized)),
      }),
    ),
  );
