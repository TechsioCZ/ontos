import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { executeApplyCommandWithAuthorization } from "@app/work-tasks/clients/apply-command";
import type { ApplyCommandPayload } from "@app/work-tasks/contracts/apply-command";
import { RecordsResponseSchema } from "@app/work-tasks/contracts/records";
import { Effect, Match, Predicate, Schema } from "effect";
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

const shellRequest = (
  config: StorefrontConfiguration,
  path: "gateway-read" | "gateway-context",
  body: {
    readonly audience: "work-tasks";
    readonly legalEntityId: string;
    readonly query?: Record<string, never>;
    readonly readName?: "records";
  },
) =>
  Effect.gen(function* shellRequestProgram() {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(`${config.shellUrl}/shell-super-app-api/auth/api-key/${path}`).pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": config.apiKey,
          "x-correlation-id": randomUUID(),
        }),
      ),
      body,
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
    return yield* response.json.pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
  });

const writeInquiry = (config: StorefrontConfiguration, payload: ApplyCommandPayload) =>
  Effect.gen(function* writeInquiryProgram() {
    // gateway-read has already redeemed its assertion; obtain a distinct assertion for this write.
    const raw = yield* shellRequest(config, "gateway-context", {
      audience: "work-tasks",
      legalEntityId: config.legalEntityId,
    });
    const context = yield* Schema.decodeUnknownEffect(ContextSchema)(raw).pipe(
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const result = yield* executeApplyCommandWithAuthorization(
      payload,
      `Bearer ${context.token}`,
      randomUUID(),
      {
        baseUrl: `${config.shellUrl}${context.apiBaseUrl}`,
        compositionRevision: context.compositionRevision,
        idempotencyKey: `n1-inquiry-${digest}`,
      },
    ).pipe(
      Effect.flatMap((outcome) =>
        Predicate.isTagged(outcome, "ActionProposalAccepted")
          ? Effect.fail(outcome)
          : Effect.succeed(outcome),
      ),
      Effect.timeout("20 seconds"),
      Effect.catchTags({
        ApplyCommandActionConflictProblem: (problem) =>
          Effect.fail(
            new InquiryFailure({
              reason: problem.code === "work_revision_conflict" ? "conflict" : "unconfirmed",
            }),
          ),
        ApplyCommandActionForbiddenProblem: () =>
          Effect.fail(new InquiryFailure({ reason: "forbidden" })),
      }),
      Effect.catch((error) =>
        Match.value(error).pipe(
          Match.tag("InquiryFailure", (failure) => Effect.fail(failure)),
          Match.orElse(() => Effect.fail(new InquiryFailure({ reason: "unconfirmed" }))),
        ),
      ),
    );
    return yield* Match.value(payload.command).pipe(
      Match.tag("CreateTask", (command) =>
        command.storefrontInquiry === undefined
          ? Effect.fail(new InquiryFailure({ reason: "unconfirmed" }))
          : confirmInquiryTask(result, config.tenantId, command.storefrontInquiry.requestId),
      ),
      Match.orElse(() => Effect.fail(new InquiryFailure({ reason: "unconfirmed" }))),
    );
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
      problem._tag === "InquiryFailure" ? problem : new InquiryFailure({ reason: "unavailable" }),
    ),
  );

export const persistInquiry = (inquiry: Inquiry) =>
  Effect.gen(function* persistInquiryProgram() {
    const config = yield* readConfiguration(process.env).pipe(
      Effect.mapError(() => new InquiryFailure({ reason: "unavailable" })),
    );
    return yield* sendInquiry(inquiry, {
      apply: (payload) => writeInquiry(config, payload),
      product: (selector) => readInquiryProduct(inquiry.locale, selector),
      revision: shellRequest(config, "gateway-read", {
        audience: "work-tasks",
        legalEntityId: config.legalEntityId,
        query: {},
        readName: "records",
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RecordsResponseSchema)),
        Effect.map((snapshot) => snapshot.revision),
        Effect.catch((error) =>
          Match.value(error).pipe(
            Match.tag("InquiryFailure", (failure) => Effect.fail(failure)),
            Match.orElse(() => Effect.fail(new InquiryFailure({ reason: "unavailable" }))),
          ),
        ),
      ),
    });
  });
