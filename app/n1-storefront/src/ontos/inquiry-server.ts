import "server-only";
import { randomUUID } from "node:crypto";
import { executeSubmitStorefrontInquiryWithAuthorization } from "@app/work-tasks/clients/submit-storefront-inquiry";
import type { SubmitStorefrontInquiryPayload } from "@app/work-tasks/contracts/submit-storefront-inquiry";
import { Effect, Match, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { StorefrontConfiguration } from "./config";
import { readConfiguration } from "./config";
import type { Inquiry, InquiryProduct } from "./inquiry";
import {
  confirmInquiryTask,
  InquiryFailure,
  resolveInquiryProduct,
  sendInquiry,
} from "./inquiry-model";
import { loadCatalog } from "./catalog";

const ContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String.check(Schema.isPattern(/^\/shell-super-app-api\/[a-z\d/-]+$/u)),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  expiresAt: Schema.Int,
  token: Schema.String.check(Schema.isMinLength(1)),
});

/** A single-use assertion for one Work Tasks write. The storefront key is admitted on no Work Tasks read. */
const mintAssertion = (config: StorefrontConfiguration) =>
  Effect.gen(function* mintAssertionProgram() {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(
        `${config.shellUrl}/shell-super-app-api/auth/api-key/gateway-context`,
      ).pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": config.apiKey,
          "x-correlation-id": randomUUID(),
        }),
      ),
      { audience: "work-tasks", legalEntityId: config.legalEntityId },
    ).pipe(Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new InquiryFailure({
        reason: response.status === 403 ? "forbidden" : "unavailable",
      });
    }
    const raw = yield* response.json.pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
    return yield* Schema.decodeUnknownEffect(ContextSchema)(raw).pipe(
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
  });

/** One `work.tasks.submit-storefront-inquiry` write under the given idempotency key; never repeated here. */
const writeInquiry = (
  config: StorefrontConfiguration,
  payload: SubmitStorefrontInquiryPayload,
  idempotencyKey: string,
) =>
  Effect.gen(function* writeInquiryProgram() {
    const context = yield* mintAssertion(config);
    const result = yield* executeSubmitStorefrontInquiryWithAuthorization(
      payload,
      `Bearer ${context.token}`,
      randomUUID(),
      {
        baseUrl: `${config.shellUrl}${context.apiBaseUrl}`,
        compositionRevision: context.compositionRevision,
        idempotencyKey,
      },
    ).pipe(
      Effect.timeout("20 seconds"),
      Effect.catchTags({
        SubmitStorefrontInquiryActionAlreadyCommittedProblem: () =>
          Effect.fail(new InquiryFailure({ reason: "committed" })),
        // A request id owned by another submission, a reused key with other content: terminal, never resent.
        SubmitStorefrontInquiryActionConflictProblem: (problem) =>
          Effect.fail(
            new InquiryFailure({
              reason: problem.code === "work_revision_conflict" ? "conflict" : "unconfirmed",
            }),
          ),
        SubmitStorefrontInquiryActionForbiddenProblem: () =>
          Effect.fail(new InquiryFailure({ reason: "forbidden" })),
      }),
      Effect.catch((error) =>
        Match.value(error).pipe(
          Match.tag("InquiryFailure", (failure) => Effect.fail(failure)),
          Match.orElse(() => Effect.fail(new InquiryFailure({ reason: "unconfirmed" }))),
        ),
      ),
    );
    return yield* confirmInquiryTask(result, config.tenantId, payload.storefrontInquiry.requestId);
  });

/** The same market-scoped public catalog backs prefill and fresh pre-write identity verification. */
export const readInquiryProduct = (locale: string, selector: InquiryProduct) =>
  loadCatalog(locale, { productId: selector.productId }).pipe(
    Effect.flatMap((catalog) =>
      catalog.configured
        ? resolveInquiryProduct(selector, catalog.details)
        : Effect.fail(new InquiryFailure({ reason: "unavailable" })),
    ),
    Effect.mapError((problem) =>
      Schema.is(InquiryFailure)(problem) ? problem : new InquiryFailure({ reason: "unavailable" }),
    ),
  );

export const persistInquiry = (inquiry: Inquiry) =>
  Effect.gen(function* persistInquiryProgram() {
    const config = yield* readConfiguration(process.env).pipe(
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
    return yield* sendInquiry(inquiry, {
      product: (selector) => readInquiryProduct(inquiry.locale, selector),
      submit: (payload, idempotencyKey) => writeInquiry(config, payload, idempotencyKey),
    });
  });
