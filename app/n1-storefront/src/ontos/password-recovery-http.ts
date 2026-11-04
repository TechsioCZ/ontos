import "server-only";
import { ByteSize, Effect, Layer, ManagedRuntime, Match, Redacted } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  PasswordRecoveryApi,
  PasswordRecoveryForbiddenProblem,
  PasswordRecoveryInvalidProblem,
  PasswordRecoveryOutcomeSchema,
  PasswordRecoveryRateLimitedProblem,
  PasswordRecoverySchemaErrorMiddleware,
  PasswordRecoveryUnavailableProblem,
} from "./password-recovery";
import {
  acceptPasswordRecovery,
  recoveryCookieName,
  requestPasswordRecovery,
  resetPasswordRecovery,
} from "./password-recovery-server";
import type { PasswordRecoveryFailure } from "./password-recovery-server";
import { normalizePublicRequest } from "./request-origin";
import { isPortalOrigin } from "./portal-model";

const callbackPrefix = "/commerce-customer-context-api/api/portal-auth/reset-password/";
const resetPath = "/api/account/password/reset";
const maxBodyBytes = 16_384;
const problemContentType = "application/problem+json";
const noStore = HttpServerResponse.setHeaders({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});
const details = {
  detail: "Password recovery could not be completed.",
  title: "Password recovery",
  type: "urn:n1:password-recovery",
};
const invalidProblem = () =>
  PasswordRecoveryInvalidProblem.make({ ...details, state: "invalid", status: 400 });
const cookieOptions = (url: string, maxAge: "0 seconds" | "10 minutes") => ({
  httpOnly: true,
  maxAge,
  path: "/",
  sameSite: "lax" as const,
  secure: new URL(url).protocol === "https:",
});
const cookieResponse = (
  response: HttpServerResponse.HttpServerResponse,
  url: string,
  token?: Redacted.Redacted,
) =>
  HttpServerResponse.setCookie(
    response,
    recoveryCookieName,
    token === undefined ? "" : Redacted.value(token),
    cookieOptions(url, token === undefined ? "0 seconds" : "10 minutes"),
  ).pipe(Effect.orDie);
const callbackRedirect = (url: string, token?: Redacted.Redacted) =>
  cookieResponse(HttpServerResponse.redirect("/cs/obnova-hesla", { status: 303 }), url, token).pipe(
    Effect.map(noStore),
  );
const responseForFailure = (state: PasswordRecoveryFailure["state"]) =>
  Match.value(state).pipe(
    Match.whenOr("invalid", "invalid-token", (value) =>
      HttpServerResponse.schemaJson(PasswordRecoveryInvalidProblem)(
        PasswordRecoveryInvalidProblem.make({ ...details, state: value, status: 400 }),
        { contentType: problemContentType, status: 400 },
      ),
    ),
    Match.when("forbidden", () =>
      HttpServerResponse.schemaJson(PasswordRecoveryForbiddenProblem)(
        PasswordRecoveryForbiddenProblem.make({ ...details, state: "forbidden", status: 403 }),
        { contentType: problemContentType, status: 403 },
      ),
    ),
    Match.when("rate-limited", () =>
      HttpServerResponse.schemaJson(PasswordRecoveryRateLimitedProblem)(
        PasswordRecoveryRateLimitedProblem.make({ ...details, state: "rate-limited", status: 429 }),
        { contentType: problemContentType, status: 429 },
      ),
    ),
    Match.orElse((value) =>
      HttpServerResponse.schemaJson(PasswordRecoveryUnavailableProblem)(
        PasswordRecoveryUnavailableProblem.make({ ...details, state: value, status: 503 }),
        { contentType: problemContentType, status: 503 },
      ),
    ),
    Effect.orDie,
    Effect.map(noStore),
  );
const schemaErrors = HttpApiMiddleware.layerSchemaErrorTransform(
  PasswordRecoverySchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);
const handlers = HttpApiBuilder.group(PasswordRecoveryApi, "passwordRecovery", (group) =>
  group
    .handle("request", ({ payload, request }) =>
      requestPasswordRecovery(payload, new URL(request.originalUrl).origin).pipe(
        Effect.matchEffect({
          onFailure: (problem) => responseForFailure(problem.state),
          onSuccess: (outcome) =>
            HttpServerResponse.schemaJson(PasswordRecoveryOutcomeSchema)(outcome).pipe(
              Effect.orDie,
            ),
        }),
      ),
    )
    .handle("reset", ({ payload, request }) =>
      resetPasswordRecovery(
        payload,
        request.headers.cookie,
        new URL(request.originalUrl).origin,
      ).pipe(
        Effect.matchEffect({
          onFailure: (problem) =>
            responseForFailure(problem.state).pipe(
              Effect.flatMap((response) =>
                problem.state === "invalid-token" || problem.state === "unconfirmed"
                  ? cookieResponse(response, request.originalUrl)
                  : Effect.succeed(response),
              ),
            ),
          onSuccess: (outcome) =>
            HttpServerResponse.schemaJson(PasswordRecoveryOutcomeSchema)(outcome).pipe(
              Effect.orDie,
              Effect.flatMap((response) => cookieResponse(response, request.originalUrl)),
            ),
        }),
      ),
    )
    .handle("callback", ({ params, query, request }) =>
      acceptPasswordRecovery(params.token, query.callbackURL).pipe(
        Effect.matchEffect({
          onFailure: () => callbackRedirect(request.originalUrl),
          onSuccess: (secret) => callbackRedirect(request.originalUrl, secret),
        }),
      ),
    ),
).pipe(Layer.provide(schemaErrors));
const responsePolicy = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* passwordRecoveryResponsePolicy() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* effect.pipe(
        Effect.catchDefect((defect) =>
          HttpServerError.isHttpServerError(defect)
            ? Match.value(defect.reason).pipe(
                Match.tag("RequestParseError", () => responseForFailure("invalid")),
                Match.orElse(() => Effect.die(defect)),
              )
            : Effect.die(defect),
        ),
      );
      if (
        new URL(request.originalUrl).pathname.startsWith(callbackPrefix) &&
        response.status >= 400
      ) {
        return yield* callbackRedirect(request.originalUrl);
      }
      return response.status === 413 ? yield* responseForFailure("invalid") : noStore(response);
    }),
  { global: true },
);
const application = Layer.merge(HttpApiBuilder.layer(PasswordRecoveryApi), responsePolicy).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
  ),
  Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBodyBytes))),
);
export const passwordRecoveryWeb = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (effect) =>
    Effect.gen(function* guardPasswordRecovery() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.originalUrl);
      if (request.method === "GET" && url.pathname.startsWith(callbackPrefix)) {
        const keys = [...url.searchParams.keys()];
        const callbacks = url.searchParams.getAll("callbackURL");
        if (
          keys.some((key) => key !== "callbackURL") ||
          callbacks.length > 1 ||
          (callbacks[0]?.length ?? 0) > 2048
        ) {
          return yield* callbackRedirect(request.originalUrl);
        }
        return yield* effect.pipe(
          Effect.timeoutOrElse({
            duration: "45 seconds",
            orElse: () => callbackRedirect(request.originalUrl),
          }),
        );
      }
      if (
        request.method !== "POST" ||
        !isPortalOrigin(request.headers.origin, request.originalUrl)
      ) {
        return yield* responseForFailure("forbidden");
      }
      const length = request.headers["content-length"];
      if (
        url.search !== "" ||
        !/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "") ||
        (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > maxBodyBytes))
      ) {
        return yield* responseForFailure("invalid");
      }
      return yield* effect.pipe(
        Effect.timeoutOrElse({
          duration: "45 seconds",
          orElse: () =>
            responseForFailure("unconfirmed").pipe(
              Effect.flatMap((response) =>
                url.pathname === resetPath
                  ? cookieResponse(response, request.originalUrl)
                  : Effect.succeed(response),
              ),
            ),
        }),
      );
    }).pipe(Effect.map(noStore)),
});
const edgeRuntime = ManagedRuntime.make(Layer.empty);
export const passwordRecoveryHandler = async (request: Request) =>
  await edgeRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () => responseForFailure("invalid").pipe(Effect.map(HttpServerResponse.toWeb)),
        onSuccess: (normalized) =>
          Effect.promise(async () => await passwordRecoveryWeb.handler(normalized)),
      }),
    ),
  );
