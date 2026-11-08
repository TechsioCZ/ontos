import "server-only";
import { Effect, Layer, ManagedRuntime, Match, Schema, Struct } from "effect";
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
  PortalMfaAuthenticationProblem,
  PortalMfaInvalidProblem,
  PortalMfaRateLimitedProblem,
  PortalMfaRefusedProblem,
  PortalMfaResultSchema,
  PortalMfaUnavailableProblem,
  PortalOutcomeSchema,
  PortalRateLimitedProblem,
  PortalRefusedProblem,
  PortalSchemaErrorMiddleware,
  PortalUnavailableProblem,
  PortalUnconfirmedProblem,
  PortalVerificationQuerySchema,
} from "./portal";
import type { PortalMfaResult, PortalOutcome } from "./portal";
import { isPortalOrigin } from "./portal-model";
import { normalizePublicRequest } from "./request-origin";
import {
  currentPortalServer,
  loginPortalServer,
  logoutPortalServer,
  portalFailureOutcome,
  portalMfaFailureOutcome,
  requestPortalMfaOtpServer,
  verifyPortalMfaServer,
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
    Match.when({ state: "refused" }, (value) =>
      HttpServerResponse.schemaJson(PortalRefusedProblem)(
        PortalRefusedProblem.make({
          ...details,
          ...Struct.pick(value, ["diagnostic"]),
          state: "refused",
          status: 403,
        }),
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
const responseForMfa = (result: PortalMfaResult) => {
  if (result.state !== "mfa-error") {
    return HttpServerResponse.schemaJson(PortalMfaResultSchema)(result);
  }
  const base = { ...details, state: "mfa-error" as const };
  return Match.value(result.reason).pipe(
    Match.when("invalid", (reason) =>
      HttpServerResponse.schemaJson(PortalMfaInvalidProblem)(
        PortalMfaInvalidProblem.make({ ...base, reason, status: 400 }),
        { contentType: problemContentType, status: 400 },
      ),
    ),
    Match.when(
      (reason) =>
        reason === "expired" || reason === "rejected" || reason === "authentication-required",
      (reason) =>
        HttpServerResponse.schemaJson(PortalMfaAuthenticationProblem)(
          PortalMfaAuthenticationProblem.make({ ...base, reason, status: 401 }),
          { contentType: problemContentType, status: 401 },
        ),
    ),
    Match.when("throttled", (reason) =>
      HttpServerResponse.schemaJson(PortalMfaRateLimitedProblem)(
        PortalMfaRateLimitedProblem.make({ ...base, reason, status: 429 }),
        { contentType: problemContentType, status: 429 },
      ),
    ),
    Match.when("refused", (reason) =>
      HttpServerResponse.schemaJson(PortalMfaRefusedProblem)(
        PortalMfaRefusedProblem.make({ ...base, reason, status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.orElse((reason) =>
      HttpServerResponse.schemaJson(PortalMfaUnavailableProblem)(
        PortalMfaUnavailableProblem.make({ ...base, reason, status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
  );
};
/** Every account operation shares the exact Origin, no-store and realm-cookie transport. */
const channel = <A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  program: (context: PortalRequestContext) => Effect.Effect<A, E, R>,
  failure: (error: E) => A,
  respond: (value: A) => ReturnType<typeof responseForOutcome>,
) =>
  Effect.gen(function* portalChannel() {
    const context = portalRequestContext(
      new URL(request.originalUrl).origin,
      request.headers.cookie,
    );
    const response =
      request.method !== "GET" && !isPortalOrigin(request.headers.origin, request.originalUrl)
        ? yield* responseForOutcome({ diagnostic: "bff-origin-refused", state: "refused" }).pipe(
            Effect.orDie,
          )
        : yield* program(context).pipe(
            Effect.match({ onFailure: failure, onSuccess: (value) => value }),
            Effect.flatMap(respond),
            Effect.orDie,
          );
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
      channel(
        request,
        (context) => loginPortalServer(payload, context),
        portalFailureOutcome,
        responseForOutcome,
      ),
    )
    .handle("requestMfaOtp", ({ request }) =>
      channel(request, requestPortalMfaOtpServer, portalMfaFailureOutcome, responseForMfa),
    )
    .handle("verifyMfa", ({ payload, request }) =>
      channel(
        request,
        (context) => verifyPortalMfaServer(payload, context),
        portalMfaFailureOutcome,
        responseForMfa,
      ),
    )
    .handle("register", ({ payload, request }) =>
      channel(
        request,
        (context) => registerPortalServer(payload, context),
        portalFailureOutcome,
        responseForOutcome,
      ),
    )
    .handle("current", ({ request }) =>
      channel(request, currentPortalServer, portalFailureOutcome, responseForOutcome),
    )
    .handle("logout", ({ request }) =>
      channel(request, logoutPortalServer, portalFailureOutcome, responseForOutcome),
    )
    .handle("resume", ({ request }) =>
      channel(
        request,
        (context) => currentPortalServer(context, true),
        portalFailureOutcome,
        responseForOutcome,
      ),
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
        return yield* responseForOutcome({
          diagnostic: "bff-origin-refused",
          state: "refused",
        }).pipe(Effect.orDie);
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
