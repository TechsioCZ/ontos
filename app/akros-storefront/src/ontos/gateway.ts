import { hasRenderLifetime, renderOperation } from "./render-operation";
import "server-only";
import { Effect, Option, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import {
  createAdmission,
  createOperation,
  createWorkPool,
  ERROR_BYTES,
  RESPONSE_BYTES,
  readBytes,
  recoverableReadAdmission,
  OperationError,
  OperationFailureSchema,
} from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";
import { getConfig } from "./config";
import { shellFetch } from "./shell-fetch";

export { createOperation, OperationError } from "@ontos/storefront-runtime";
export type { Operation, OperationOptions } from "@ontos/storefront-runtime";
const GATEWAY_CONTEXT_PATH = "/shell-super-app-api/auth/api-key/gateway-context";
const GATEWAY_READ_PATH = "/shell-super-app-api/auth/api-key/gateway-read";
const admission = createAdmission();
const workPool = createWorkPool();
type GatewayPhase = "gateway-context" | "gateway-read" | "owner-request";
const NativeFetchCode = Schema.Literals([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
]);
const FetchFailure = Schema.Union([
  Schema.Struct({ cause: Schema.Struct({ code: NativeFetchCode }) }),
  Schema.Struct({ code: NativeFetchCode }),
]);
const OperationAbort = Schema.Struct({
  _tag: Schema.Literal("OperationError"),
  kind: OperationFailureSchema,
});
const nativeFetchCode = (error: unknown) => {
  try {
    return Option.match(Schema.decodeUnknownOption(FetchFailure)(error), {
      onNone: () => "unavailable",
      onSome: (failure) => ("cause" in failure ? failure.cause.code : failure.code),
    });
  } catch {
    // Even malformed external error properties must not replace the transport's API error.
    return "unavailable";
  }
};

export class OntosError extends Error {
  static is(value: unknown): value is OntosError {
    return value !== null && value !== undefined && OntosError.prototype.isPrototypeOf(value);
  }
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly body: unknown;
  constructor(message: string, status: number, code?: string, detail?: string, body?: unknown) {
    super(message);
    this.name = "OntosError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}
interface GatewayContext {
  readonly apiBaseUrl: string;
  readonly compositionRevision: string;
  readonly token: string;
}

/** The native owner transport runs one scoped admission/permit chain, including body consumption. */
const ownerWork = <A, E>(
  options: OperationOptions,
  work: (operation: Operation) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* ownerLifetime() {
        const standalone = options.operation === undefined && !hasRenderLifetime();
        const base =
          options.operation ?? (standalone ? yield* createOperation() : renderOperation());
        if (standalone) yield* Effect.addFinalizer(() => Effect.sync(base.dispose));
        const operation = options.signal
          ? yield* createOperation({
              signal: AbortSignal.any([base.signal, options.signal]),
              parent: base,
            })
          : base;
        if (operation !== base) yield* Effect.addFinalizer(() => Effect.sync(operation.dispose));
        yield* admission.acquire(operation);
        yield* workPool.acquire(operation);
        return yield* operation.run(work(operation));
      }),
    ),
  );

/** The Web fetch Promise enters Effect only at this native transport boundary. */
const reach = (
  url: string,
  init: RequestInit,
  operation: Operation,
  phase: GatewayPhase,
  onResponse?: (response: Response) => Effect.Effect<void>,
) =>
  operation.run(
    Effect.tryPromise({
      try: () => shellFetch(url, { ...init, signal: operation.signal }),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("AKROS gateway fetch failed").pipe(
          Effect.annotateLogs({
            gatewayPhase: phase,
            signalAborted: operation.signal.aborted,
            abortKind: Option.match(
              Schema.decodeUnknownOption(OperationAbort)(operation.signal.reason),
              { onNone: () => "unavailable", onSome: (reason) => reason.kind },
            ),
            nativeCauseCode: nativeFetchCode(error),
          }),
          Effect.andThen(
            Effect.fail(new OntosError("OntOS is unreachable", 503, "backend_unreachable")),
          ),
        ),
      ),
      Effect.tap((response) => onResponse?.(response) ?? Effect.void),
    ),
  );

const credentialRequest = Effect.fn("akros.credentialRequest")(function* credentialRequest(
  path: typeof GATEWAY_CONTEXT_PATH | typeof GATEWAY_READ_PATH,
  body: unknown,
  operation: Operation,
) {
  const config = getConfig();
  if (config.apiKey === undefined)
    return yield* Effect.fail(
      new OntosError(
        "ONTOS_AKROS_STOREFRONT_API_KEY is not configured",
        503,
        "storefront_not_configured",
      ),
    );
  return yield* reach(
    `${config.shellUrl}${path}`,
    {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "x-correlation-id": randomUUID(),
      },
      method: "POST",
      cache: "no-store",
      redirect: "manual",
    },
    operation,
    path === GATEWAY_CONTEXT_PATH ? "gateway-context" : "gateway-read",
  );
});
const parseContext = (body: unknown): GatewayContext => {
  if (
    body === null ||
    typeof body !== "object" ||
    !("apiBaseUrl" in body) ||
    typeof body.apiBaseUrl !== "string" ||
    !body.apiBaseUrl.startsWith("/shell-super-app-api/") ||
    !("token" in body) ||
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    !("compositionRevision" in body) ||
    typeof body.compositionRevision !== "string" ||
    !/^[\da-f]{64}$/u.test(body.compositionRevision) ||
    !("expiresAt" in body) ||
    typeof body.expiresAt !== "number" ||
    !Number.isSafeInteger(body.expiresAt)
  )
    throw new OntosError("Gateway context response is malformed", 502, "gateway_context_malformed");
  return {
    apiBaseUrl: body.apiBaseUrl,
    compositionRevision: body.compositionRevision,
    token: body.token,
  };
};
const failure = (response: Response, body: unknown, path: string): OntosError => {
  const problem = body !== null && typeof body === "object" ? body : {};
  const code = "code" in problem && typeof problem.code === "string" ? problem.code : undefined;
  const detail =
    "detail" in problem && typeof problem.detail === "string" ? problem.detail : undefined;
  return new OntosError(
    `OntOS ${path} failed: HTTP ${response.status}`,
    response.status,
    code,
    detail,
    body,
  );
};
const parseResponse = Effect.fn("akros.parseResponse")(function* parseResponse(
  response: Response,
  path: string,
  operation: Operation,
) {
  const bytes = yield* readBytes(response, {
    operation,
    maxBytes: response.ok ? RESPONSE_BYTES : ERROR_BYTES,
  });
  const body = yield* Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
    catch: (cause) => cause,
  }).pipe(Effect.catch((error) => (response.ok ? Effect.fail(error) : Effect.succeed(undefined))));
  if (!response.ok) return yield* Effect.fail(failure(response, body, path));
  return body;
});
const mintContext = Effect.fn("akros.mintContext")(function* mintContext(
  audience: string,
  operation: Operation,
) {
  const response = yield* credentialRequest(
    GATEWAY_CONTEXT_PATH,
    { audience, legalEntityId: getConfig().legalEntityId },
    operation,
  );
  const body = yield* parseResponse(response, GATEWAY_CONTEXT_PATH, operation);
  return yield* Effect.try({ try: () => parseContext(body), catch: (cause) => cause });
});
const segment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))
    throw new Error(`Invalid path segment ${value}`);
  return encodeURIComponent(value);
};
const retryRead = <A, E>(
  operation: Operation,
  attempt: Effect.Effect<A, E>,
): Effect.Effect<A, E | OperationError> =>
  attempt.pipe(
    Effect.retry({
      times: 2,
      while: (error) =>
        OntosError.is(error) &&
        Schema.is(Schema.Json)(error.body) &&
        recoverableReadAdmission(error.status, error.body),
      schedule: Schedule.exponential("400 millis"),
    }),
    operation.run,
  );

/** Every attempt issues/redeems a new assertion; arbitrary denials/contracts never authorize replay. */
export const readRecords = (
  vertical: string,
  readName: string,
  query: unknown,
  { company = true, ...options }: OperationOptions & { company?: boolean } = {},
): Promise<unknown> =>
  ownerWork(options, (operation) =>
    retryRead(
      operation,
      Effect.gen(function* readAttempt() {
        const name = yield* Effect.try({ try: () => segment(readName), catch: (cause) => cause });
        const path = `/reads/${name}`;
        const response = yield* credentialRequest(
          GATEWAY_READ_PATH,
          {
            audience: vertical,
            ...(company ? { legalEntityId: getConfig().legalEntityId } : {}),
            readName: name,
            query,
          },
          operation,
        );
        // Drain/validate the bounded body even if the assertion header is absent or malformed.
        const body = yield* parseResponse(response, path, operation);
        const encoded = response.headers.get("x-ontos-gateway-context");
        if (encoded === null)
          return yield* Effect.fail(
            new OntosError(
              "Gateway read response has no assertion",
              502,
              "gateway_context_malformed",
            ),
          );
        yield* Effect.try({
          try: () => parseContext(JSON.parse(encoded)),
          catch: () =>
            new OntosError(
              "Gateway context response is malformed",
              502,
              "gateway_context_malformed",
            ),
        });
        return body;
      }),
    ),
  );

const safeAccountRead = (path: string, init: RequestInit) =>
  (init.method ?? "GET") === "GET" &&
  init.body === undefined &&
  [
    "/api/portal-auth/customer-account",
    "/api/portal-auth/enrollment/current",
    "/api/portal-auth/customer-consent",
  ].includes(path);

export interface OwnerRequestOptions extends OperationOptions {
  /** Native response observation precedes body bounds, parsing and the operation's final deadline check. */
  readonly onResponse?: (response: Response) => Effect.Effect<void>;
}

/** Buffer before returning: the deadline/permit cover the body, not just response headers. */
export const ownerRequest = (
  vertical: string,
  path: string,
  init: RequestInit,
  options: OwnerRequestOptions = {},
): Promise<Response> => {
  if (!path.startsWith("/api/") || path.includes("..")) throw new Error("Invalid owner path");
  const signal =
    init.signal && options.signal
      ? AbortSignal.any([init.signal, options.signal])
      : (init.signal ?? options.signal);
  return ownerWork({ ...options, ...(signal ? { signal } : {}) }, (operation) => {
    const attempt = Effect.gen(function* ownerAttempt() {
      const context = yield* mintContext(vertical, operation);
      const response = yield* reach(
        `${getConfig().shellUrl}${context.apiBaseUrl}${path}`,
        {
          ...init,
          cache: "no-store",
          redirect: "manual",
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            authorization: `Bearer ${context.token}`,
            "x-correlation-id": randomUUID(),
            "x-ontos-composition-revision": context.compositionRevision,
          },
        },
        operation,
        "owner-request",
        options.onResponse,
      );
      const bytes = yield* readBytes(response, {
        operation,
        maxBytes: response.ok ? RESPONSE_BYTES : ERROR_BYTES,
      });
      let body: unknown;
      if (bytes.byteLength && response.headers.get("content-type")?.includes("json")) {
        body = yield* Effect.try({
          try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((error) => (response.ok ? Effect.fail(error) : Effect.succeed(undefined))),
        );
      }
      if (
        safeAccountRead(path, init) &&
        Schema.is(Schema.Json)(body) &&
        recoverableReadAdmission(response.status, body)
      )
        return yield* Effect.fail(failure(response, body, path));
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
    return safeAccountRead(path, init) ? retryRead(operation, attempt) : attempt;
  });
};

/** Mutations, including consuming GETs, are sent once. The caller owns its idempotency key. */
export const callAction = (
  vertical: string,
  actionSlug: string,
  payload: unknown,
  idempotencyKey: string,
  options: OperationOptions = {},
): Promise<unknown> =>
  ownerWork(options, (operation) =>
    Effect.gen(function* actionAttempt() {
      const context = yield* mintContext(vertical, operation);
      const path = yield* Effect.try({
        try: () => `/${segment(vertical)}/actions/${segment(actionSlug)}`,
        catch: (cause) => cause,
      });
      const response = yield* reach(
        `${getConfig().shellUrl}${context.apiBaseUrl}${path}`,
        {
          body: JSON.stringify(payload),
          method: "POST",
          cache: "no-store",
          redirect: "manual",
          headers: {
            authorization: `Bearer ${context.token}`,
            "content-type": "application/json",
            "x-correlation-id": randomUUID(),
            "x-ontos-composition-revision": context.compositionRevision,
            "idempotency-key": idempotencyKey,
          },
        },
        operation,
        "owner-request",
      );
      return yield* parseResponse(response, path, operation);
    }),
  );
