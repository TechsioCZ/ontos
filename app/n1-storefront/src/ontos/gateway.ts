import "server-only";
import { randomUUID } from "node:crypto";
import { Clock, Effect, Exit, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { recoverableReadAdmission } from "@ontos/storefront-runtime";
import type { OperationOptions } from "@ontos/storefront-runtime";
import { boundedBody, withOwnerOperation } from "./owner-operation";
import type { StorefrontConfiguration } from "./config";

type OwnerReadQuery =
  | { readonly at: string }
  | { readonly image: string; readonly productId: string; readonly rendition: "full" | "thumbnail" }
  | {
      readonly view: {
        readonly storefront: true;
        readonly storefrontCustomerOrders: {
          readonly customerAccountId: string;
          readonly offset: number;
          readonly orderId?: string;
        };
      };
    }
  | {
      readonly view: {
        readonly includeCategories: false;
        readonly limit: 0;
        readonly orderClientRequestId: string;
        readonly ordersLimit: 1;
        readonly storefront: true;
      };
    }
  | {
      readonly view: {
        readonly storefront: true;
        readonly storefrontCatalog:
          | {
              readonly categorySlug?: string;
              readonly featured?: boolean;
              readonly fields: "card" | "full";
              readonly includeCategories: boolean;
              readonly marketId: string;
              readonly page?: number;
              readonly pageSize: number;
              readonly productIds?: readonly string[];
              readonly q?: string;
              readonly slug?: string;
              readonly storefrontAppId?: string;
            }
          | {
              readonly includeCategories: false;
              /** Absent only for the company-wide catalogue revision head read. */
              readonly marketId?: string;
              readonly mode: "categories";
            };
        readonly storefrontCheckout?: true;
      };
    };

export class StorefrontReadUnavailable extends Schema.TaggedError<StorefrontReadUnavailable>()(
  "StorefrontReadUnavailable",
  {
    reason: Schema.Literals([
      "transport",
      "forbidden",
      "response",
      "contract",
      "cancelled",
      "deadline",
      "overloaded",
      "body_oversize",
    ]),
    retryable: Schema.optionalKey(Schema.Boolean),
    status: Schema.optionalKey(Schema.Number),
  },
) {}

const GatewayContextSchema = Schema.Struct({
  apiBaseUrl: Schema.String.check(Schema.isPattern(/^\/shell-super-app-api\//u)),
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  expiresAt: Schema.Int,
  token: Schema.String.check(Schema.isMinLength(1)),
});

type OwnerAudience = "merchandise" | "commerce-market-catalog";
type OwnerReadName = "records" | "current-market-catalog" | "media";

/** The gateway's phase timings are short `name;dur=` entries; bound the value so a log line stays one line. */
const SERVER_TIMING_LOG_LIMIT = 512;

interface OwnerReadAttempt {
  readonly attempt: number;
  readonly audience: OwnerAudience;
  readonly correlationId: string;
  readonly readName: OwnerReadName;
  readonly startedAt: number;
}

/**
 * One Info line (visible on stage; Debug is below Effect's default minimum) per upstream attempt, so a slow render
 * explains itself by correlation id. Only closed identifiers and timings: never the key, query, body or customer data.
 */
const logOwnerRead = (
  read: OwnerReadAttempt,
  status: number | "transport",
  serverTiming: string | null,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((endedAt) =>
      Effect.logInfo("N1 gateway read").pipe(
        Effect.annotateLogs({
          attempt: read.attempt,
          audience: read.audience,
          correlationId: read.correlationId,
          durationMs: endedAt - read.startedAt,
          readName: read.readName,
          serverTiming:
            serverTiming === null
              ? "none"
              : serverTiming.replaceAll(/[\r\n]/gu, " ").slice(0, SERVER_TIMING_LOG_LIMIT),
          status,
        }),
      ),
    ),
  );

const decodeOwnerResponse = <A, I>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Codec<A, I>,
) =>
  Effect.gen(function* decodeOwnerResponseProgram() {
    const bytes = yield* boundedBody(response).pipe(
      Effect.mapError(
        () => new StorefrontReadUnavailable({ reason: "contract", status: response.status }),
      ),
    );
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
      new TextDecoder().decode(bytes),
    ).pipe(
      Effect.mapError(
        () =>
          new StorefrontReadUnavailable({
            reason: response.status === 401 || response.status === 403 ? "forbidden" : "contract",
            status: response.status,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new StorefrontReadUnavailable({
        reason: response.status === 401 || response.status === 403 ? "forbidden" : "response",
        retryable: recoverableReadAdmission(response.status, body),
        status: response.status,
      });
    }
    // The combined gateway returns the assertion it already redeemed; it must never be reused.
    if (!response.headers["x-ontos-gateway-context"]) {
      return yield* new StorefrontReadUnavailable({ reason: "contract" });
    }
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayContextSchema))(
      response.headers["x-ontos-gateway-context"],
    ).pipe(Effect.mapError(() => new StorefrontReadUnavailable({ reason: "contract" })));
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => new StorefrontReadUnavailable({ reason: "contract" })),
    );
  });

/** Same combined governed read used by AKROS. The service credential never crosses the server edge. */
export const readOwner = <A, I>(
  config: StorefrontConfiguration,
  audience: OwnerAudience,
  readName: OwnerReadName,
  query: OwnerReadQuery,
  schema: Schema.Codec<A, I>,
  options: OperationOptions = {},
) =>
  withOwnerOperation(
    Effect.suspend(() => {
      // Counted per execution of this read, across its retries.
      let attempt = 0;
      return Effect.gen(function* readOwnerProgram() {
        attempt += 1;
        const correlationId = randomUUID();
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(
            `${config.shellUrl}/shell-super-app-api/auth/api-key/gateway-read`,
          ).pipe(
            HttpClientRequest.setHeaders({
              "x-api-key": config.apiKey,
              "x-correlation-id": correlationId,
            }),
          ),
          { audience, legalEntityId: config.legalEntityId, query, readName },
        ).pipe(Effect.mapError(() => new StorefrontReadUnavailable({ reason: "contract" })));
        const read: OwnerReadAttempt = {
          attempt,
          audience,
          correlationId,
          readName,
          startedAt: yield* Clock.currentTimeMillis,
        };
        const response = yield* HttpClient.execute(request).pipe(
          Effect.onExitIf(Exit.isFailure, () => logOwnerRead(read, "transport", null)),
          Effect.mapError(() => new StorefrontReadUnavailable({ reason: "transport" })),
        );
        yield* logOwnerRead(read, response.status, response.headers["server-timing"] ?? null);
        return yield* decodeOwnerResponse(response, schema);
      }).pipe(
        Effect.retry({
          schedule: Schedule.spaced("400 millis"),
          times: 2,
          while: (error) => error.reason === "response" && error.retryable === true,
        }),
      );
    }),
    options,
  ).pipe(
    Effect.catchTags({
      OperationError: (error) => Effect.fail(new StorefrontReadUnavailable({ reason: error.kind })),
      SchemaError: () => Effect.fail(new StorefrontReadUnavailable({ reason: "contract" })),
    }),
  );
