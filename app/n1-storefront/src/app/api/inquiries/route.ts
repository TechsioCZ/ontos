import type { OperationError } from "@ontos/storefront-runtime";
import { INGRESS_BYTES } from "@ontos/storefront-runtime";
import {
  actionMayHaveDispatched,
  storefrontHttpClientLayer,
  ownerHttp,
} from "@/ontos/owner-operation";
import { ByteSize, Effect, Layer, Match, Schema } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
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
const toInquiryProblem = (error: InquiryFailure | OperationError, dispatched: boolean) =>
  Match.value(
    Match.value(error).pipe(
      Match.tag("OperationError", () =>
        dispatched ? ("unconfirmed" as const) : ("unavailable" as const),
      ),
      Match.tag("InquiryFailure", (failure) =>
        failure.reason === "unconfirmed" && !dispatched ? ("unavailable" as const) : failure.reason,
      ),
      Match.exhaustive,
    ),
  ).pipe(
    Match.when("invalid", () => InquiryInvalid.make({ ...details, status: 400 })),
    Match.when("forbidden", () => InquiryForbidden.make({ ...details, status: 403 })),
    Match.whenOr("unconfirmed", "committed", () =>
      InquiryUnconfirmed.make({ ...details, status: 503 }),
    ),
    Match.whenOr("conflict", "unavailable", () =>
      InquiryUnavailable.make({ ...details, status: 503 }),
    ),
    Match.exhaustive,
  );
const failInquiry = Effect.fn("n1.inquiryProblem")(function* failInquiry(failure: InquiryFailure) {
  return yield* Effect.fail(toInquiryProblem(failure, yield* actionMayHaveDispatched));
});
const handlers = HttpApiBuilder.group(InquiryApi, "inquiry", (group) =>
  group.handle("submit", ({ payload }) =>
    Effect.gen(function* inquiryRoute() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // This channel holds a service credential: accept writes only from this same-origin form.
      if (!isInquiryOrigin(request.headers.origin, request.originalUrl)) {
        return yield* Effect.fail(InquiryForbidden.make({ ...details, status: 403 }));
      }
      return yield* persistInquiry(payload).pipe(Effect.catch(failInquiry));
    }),
  ),
);
const application = HttpApiBuilder.layer(InquiryApi).pipe(
  Layer.provide(handlers),
  Layer.provide(HttpServer.layerServices),
  Layer.provideMerge(
    storefrontHttpClientLayer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", redirect: "manual" }),
      ),
    ),
  ),
  Layer.provideMerge(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(INGRESS_BYTES))),
);
const inquiryOperationFailure = (error: OperationError) =>
  Effect.gen(function* inquiryFailureResponse() {
    const failure = toInquiryProblem(error, yield* actionMayHaveDispatched);
    return yield* HttpServerResponse.schemaJson(
      Schema.Union([InquiryInvalid, InquiryForbidden, InquiryUnavailable, InquiryUnconfirmed]),
    )(failure, { contentType: "application/problem+json", status: failure.status }).pipe(
      Effect.orDie,
    );
  });
const web = HttpRouter.toWebHandler(application, {
  disableLogger: true,
  middleware: (program) => ownerHttp(program, inquiryOperationFailure),
});
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
