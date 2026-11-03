import { Effect, Layer, Match } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  InquiryApi,
  InquiryForbidden,
  InquiryInvalid,
  InquiryUnavailable,
  InquiryUnconfirmed,
} from "@/ontos/inquiry";
import { isInquiryOrigin } from "@/ontos/inquiry-model";
import type { InquiryFailure } from "@/ontos/inquiry-model";
import { persistInquiry } from "@/ontos/inquiry-server";
import { normalizePublicRequest } from "@/ontos/request-origin";
import { storefrontRuntime } from "@/ontos/runtime";

export const dynamic = "force-dynamic";
const details = {
  detail: "The inquiry was not confirmed.",
  title: "Inquiry submission",
  type: "urn:n1:inquiry",
};
const toInquiryProblem = (error: InquiryFailure) =>
  Match.value(error.reason).pipe(
    Match.when("invalid", () => InquiryInvalid.make({ ...details, status: 400 })),
    Match.when("forbidden", () => InquiryForbidden.make({ ...details, status: 403 })),
    Match.when("unconfirmed", () => InquiryUnconfirmed.make({ ...details, status: 503 })),
    Match.whenOr("conflict", "unavailable", () =>
      InquiryUnavailable.make({ ...details, status: 503 }),
    ),
    Match.exhaustive,
  );
const handlers = HttpApiBuilder.group(InquiryApi, "inquiry", (group) =>
  group.handle("submit", ({ payload }) =>
    Effect.gen(function* inquiryRoute() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // This channel holds a service credential: accept writes only from this same-origin form.
      if (!isInquiryOrigin(request.headers.origin, request.originalUrl)) {
        return yield* Effect.fail(InquiryForbidden.make({ ...details, status: 403 }));
      }
      return yield* persistInquiry(payload).pipe(Effect.mapError(toInquiryProblem));
    }),
  ),
);
const application = HttpApiBuilder.layer(InquiryApi).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
      ),
    ),
  ),
);
const web = HttpRouter.toWebHandler(application, { disableLogger: true });
export const POST = async (request: Request) =>
  await storefrontRuntime.runPromise(
    normalizePublicRequest(request).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed(
            Response.json(InquiryInvalid.make({ ...details, status: 400 }), {
              headers: { "cache-control": "no-store" },
              status: 400,
            }),
          ),
        onSuccess: (normalized) => Effect.promise(async () => await web.handler(normalized)),
      }),
    ),
  );
