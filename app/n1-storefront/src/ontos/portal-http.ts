import "server-only";
import { Effect, Layer, ManagedRuntime, Match, Schema } from "effect";
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
  PortalApi,
  PortalCredentialsProblem,
  PortalInvalidProblem,
  PortalOutcomeSchema,
  PortalRateLimitedProblem,
  PortalRefusedProblem,
  PortalSchemaErrorMiddleware,
  PortalUnavailableProblem,
  PortalUnconfirmedProblem,
  PortalVerificationQuerySchema,
} from "./portal";
import type { PortalOutcome } from "./portal";
import { isPortalOrigin } from "./portal-model";
import { normalizePublicRequest } from "./request-origin";
import {
  currentPortalServer,
  loginPortalServer,
  logoutPortalServer,
  portalFailureOutcome,
  portalRequestContext,
  registerPortalServer,
  verifyPortalEmailServer,
} from "./portal-server";
import type { PortalRequestContext } from "./portal-server";

const problemContentType = "application/problem+json";
const details = {
  detail: "Portal account request could not be completed.",
  title: "Portal account",
  type: "urn:n1:portal-account",
};
const invalidProblem = () =>
  PortalInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const verificationRedirect = (state: "verified" | "reconciliation" | "invalid" | "unconfirmed") =>
  HttpServerResponse.redirect(`/cs/prihlaseni?verification=${state}`, {
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    status: 303,
  });
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(PortalSchemaErrorMiddleware, () =>
  Effect.fail(invalidProblem()),
);
const responseForOutcome = (outcome: PortalOutcome) =>
  Match.value(outcome).pipe(
    Match.when({ state: "invalid" }, () =>
      HttpServerResponse.schemaJson(PortalInvalidProblem)(invalidProblem(), {
        contentType: problemContentType,
        status: 400,
      }),
    ),
    Match.when({ state: "credentials" }, () =>
      HttpServerResponse.schemaJson(PortalCredentialsProblem)(
        PortalCredentialsProblem.make({ ...details, state: "credentials", status: 401 }),
        { contentType: problemContentType, status: 401 },
      ),
    ),
    Match.when({ state: "refused" }, () =>
      HttpServerResponse.schemaJson(PortalRefusedProblem)(
        PortalRefusedProblem.make({ ...details, state: "refused", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when({ state: "rate-limited" }, (value) =>
      HttpServerResponse.schemaJson(PortalRateLimitedProblem)(
        PortalRateLimitedProblem.make({
          ...details,
          retryAfterSeconds: value.retryAfterSeconds,
          state: "rate-limited",
          status: 429,
        }),
        { contentType: problemContentType, status: 429 },
      ),
    ),
    Match.when({ state: "unavailable" }, () =>
      HttpServerResponse.schemaJson(PortalUnavailableProblem)(
        PortalUnavailableProblem.make({ ...details, state: "unavailable", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.when({ state: "unconfirmed" }, () =>
      HttpServerResponse.schemaJson(PortalUnconfirmedProblem)(
        PortalUnconfirmedProblem.make({ ...details, state: "unconfirmed", status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Match.orElse((value) => HttpServerResponse.schemaJson(PortalOutcomeSchema)(value)),
  );
type OwnerProgram =
  | ReturnType<typeof loginPortalServer>
  | ReturnType<typeof registerPortalServer>
  | ReturnType<typeof currentPortalServer>
  | ReturnType<typeof logoutPortalServer>;
type PortalProgram = Effect.Effect<
  PortalOutcome,
  Effect.Error<OwnerProgram>,
  Effect.Services<OwnerProgram>
>;
const channel = (
  request: HttpServerRequest.HttpServerRequest,
  program: (context: PortalRequestContext) => PortalProgram,
) =>
  Effect.gen(function* portalChannel() {
    const context = portalRequestContext(
      new URL(request.originalUrl).origin,
      request.headers.cookie,
    );
    const result =
      request.method !== "GET" && !isPortalOrigin(request.headers.origin, request.originalUrl)
        ? { state: "refused" as const }
        : yield* program(context).pipe(
            Effect.match({
              onFailure: portalFailureOutcome,
              onSuccess: (value): PortalOutcome => value,
            }),
          );
    const response = yield* responseForOutcome(result).pipe(Effect.orDie);
    return response.pipe(
      HttpServerResponse.setHeaders({
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      }),
      HttpServerResponse.replaceCookies(Cookies.fromSetCookie(context.setCookies)),
    );
  });
const handlers = HttpApiBuilder.group(PortalApi, "portal", (group) =>
  group
    .handle("verifyEmail", ({ query }) =>
      verifyPortalEmailServer(query.token).pipe(Effect.map(verificationRedirect)),
    )
    .handle("login", ({ payload, request }) =>
      channel(request, (context) => loginPortalServer(payload, context)),
    )
    .handle("register", ({ payload, request }) =>
      channel(request, (context) => registerPortalServer(payload, context)),
    )
    .handle("current", ({ request }) => channel(request, currentPortalServer))
    .handle("logout", ({ request }) => channel(request, logoutPortalServer))
    .handle("resume", ({ request }) =>
      channel(request, (context) => currentPortalServer(context, true)),
    ),
).pipe(Layer.provide(schemaErrors));
const application = HttpApiBuilder.layer(PortalApi).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
  ),
);
export const portalWeb = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (effect) =>
    Effect.gen(function* guardPortalRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.method !== "GET" &&
        !isPortalOrigin(request.headers.origin, request.originalUrl)
      ) {
        return yield* responseForOutcome({ state: "refused" }).pipe(Effect.orDie);
      }
      const url = new URL(request.originalUrl);
      if (
        url.pathname === "/commerce-customer-context-api/api/portal-auth/verify-email" &&
        request.method === "GET"
      ) {
        const tokens = url.searchParams.getAll("token");
        const callbacks = url.searchParams.getAll("callbackURL");
        const [token] = tokens;
        const [callbackURL] = callbacks;
        if (
          tokens.length !== 1 ||
          token === undefined ||
          callbacks.length > 1 ||
          [...url.searchParams.keys()].some((key) => key !== "token" && key !== "callbackURL")
        ) {
          return verificationRedirect("invalid");
        }
        const query = callbackURL === undefined ? { token } : { callbackURL, token };
        if (!Schema.is(PortalVerificationQuerySchema)(query)) {
          return verificationRedirect("invalid");
        }
      } else if (url.search !== "") {
        return yield* responseForOutcome({ state: "invalid" }).pipe(Effect.orDie);
      }
      return yield* effect;
    }),
});
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const portalHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () =>
          responseForOutcome({ state: "invalid" }).pipe(
            Effect.orDie,
            Effect.map(HttpServerResponse.toWeb),
          ),
        onSuccess: (normalized) => Effect.promise(async () => await portalWeb.handler(normalized)),
      }),
    ),
  );
