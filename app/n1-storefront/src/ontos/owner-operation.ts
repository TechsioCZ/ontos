import { hasRenderLifetime, renderOperation } from "./render-operation";
import "server-only";
import { constFalse, constUndefined } from "effect/Function";
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  createAdmission,
  createByteCollector,
  createOperation,
  createWorkPool,
  ERROR_BYTES,
  OperationError,
  RESPONSE_BYTES,
} from "@ontos/storefront-runtime";
import type { Operation, OperationOptions } from "@ontos/storefront-runtime";

/** Fiber-local explicit holder, not mutable global request state. */
export const CurrentOperation = Context.Reference<Operation | undefined>("n1/OwnerOperation", {
  defaultValue: constUndefined,
});
/** Media denial/not-found is determined by headers, not by an optional problem body. */
export const MissingMediaIsTerminal = Context.Reference<boolean>("n1/MissingMediaIsTerminal", {
  defaultValue: constFalse,
});
const admission = createAdmission();
const workPool = createWorkPool();
const isOperationError = Schema.is(Schema.instanceOf(OperationError));

const CurrentActionDispatch = Context.Reference<Ref.Ref<boolean> | undefined>("n1/ActionDispatch", {
  defaultValue: constUndefined,
});

/** One monotonic dispatch observation across this request, including an explicit domain resend. */
export const withActionDispatch = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* actionDispatchBoundary() {
    const inherited = yield* CurrentActionDispatch;
    const state = inherited ?? (yield* Ref.make(false));
    return yield* program.pipe(Effect.updateService(CurrentActionDispatch, () => state));
  });

export const actionMayHaveDispatched = CurrentActionDispatch.pipe(
  Effect.flatMap((state) => (state === undefined ? Effect.succeed(false) : Ref.get(state))),
);

/** Installed only on mutating generated Action clients, immediately before native transport. */
export const recordActionDispatch = CurrentActionDispatch.pipe(
  Effect.flatMap((state) =>
    state === undefined
      ? Effect.die(new Error("Missing Action dispatch boundary"))
      : Ref.set(state, true),
  ),
);

/** Acquire before the first mint; one permit lasts through native decode/failure and all read attempts. */
export const withOwnerOperation = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: OperationOptions = {},
): Effect.Effect<A, E | OperationError | Schema.SchemaError, R> =>
  Effect.gen(function* ownerOperation() {
    const inherited = yield* CurrentOperation;
    if (
      inherited !== undefined &&
      (options.operation === undefined || options.operation === inherited) &&
      options.signal === undefined
    ) {
      return yield* inherited.run(program);
    }
    const standalone =
      options.operation === undefined && inherited === undefined && !hasRenderLifetime();
    const current =
      options.operation ??
      inherited ??
      (standalone
        ? yield* createOperation()
        : yield* Effect.promise(async () => await renderOperation()));
    const operation = options.signal
      ? yield* createOperation({
          parent: current,
          signal: AbortSignal.any([current.signal, options.signal]),
        })
      : current;
    return yield* admission.acquire(operation).pipe(
      Effect.andThen(
        operation.run(program.pipe(Effect.updateService(CurrentOperation, () => operation))),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (operation !== current) {
            operation.dispose();
          }
          if (standalone) {
            current.dispose();
          }
        }),
      ),
    );
  });

const operationStatuses = {
  body_oversize: 502,
  cancelled: 499,
  deadline: 504,
  overloaded: 503,
} as const;
const operationFailureResponse = (error: OperationError) =>
  HttpServerResponse.jsonUnsafe(
    { code: error.kind, state: "unavailable" },
    { headers: { "cache-control": "no-store" }, status: operationStatuses[error.kind] },
  );

/** Native HTTP boundary supplies the browser signal; never try to set FetchHttpClient.RequestInit.signal. */
export const ownerHttp = <E, R>(
  program: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  onFailure: (
    error: OperationError,
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse> = (error) =>
    Effect.succeed(operationFailureResponse(error)),
) =>
  withActionDispatch(
    Effect.gen(function* ownerHttpBoundary() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* withOwnerOperation(program, {
        signal: Schema.is(Schema.instanceOf(Request))(request.source)
          ? request.source.signal
          : undefined,
      }).pipe(
        Effect.catchIf(
          (error): error is OperationError => isOperationError(error),
          (error) => onFailure(error, request),
        ),
      );
    }),
  );

/** Native stream consumption: no unbounded response.json/arrayBuffer, including error bodies. */
export const boundedBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* boundedBodyProgram() {
    const operation = yield* CurrentOperation;
    const collector = createByteCollector(
      response.status >= 200 && response.status < 300 ? RESPONSE_BYTES : ERROR_BYTES,
    );
    yield* response.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.try({
          catch: (error) => (isOperationError(error) ? error : new OperationError("body_oversize")),
          try: () => {
            operation?.check();
            collector.push(chunk);
          },
        }),
      ),
    );
    if (operation) {
      yield* operation.run(Effect.void);
    }
    return collector.finish();
  }).pipe(
    Effect.tapErrorTag(
      "OperationError",
      Effect.fn("n1.markOperationFailure")(function* markOperationFailure({ kind }) {
        const operation = yield* CurrentOperation;
        operation?.abort(kind);
      }),
    ),
  );

/** Keep the native typed client (including generated Actions and Portal APIs); only bound its wire body. */
export const boundOwnerClient = (
  client: HttpClient.HttpClient,
  onDispatch: Effect.Effect<void> = Effect.void,
): HttpClient.HttpClient =>
  HttpClient.makeWith(
    Effect.flatMap((request) =>
      Effect.scoped(
        Effect.gen(function* boundedNativeResponse() {
          const operation = yield* CurrentOperation;
          if (operation) {
            yield* workPool.acquire(operation).pipe(
              Effect.mapError((failure) => {
                if (isOperationError(failure)) {
                  operation.abort(failure.kind);
                }
                return new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ cause: failure, request }),
                });
              }),
            );
          }
          yield* onDispatch;
          const response = yield* HttpClient.withScope(client).postprocess(Effect.succeed(request));
          const missingMedia =
            (yield* MissingMediaIsTerminal) && (response.status === 403 || response.status === 404);
          // withScope closes the unread upstream response on exit, without retaining its error body.
          const bytes = missingMedia
            ? new Uint8Array()
            : yield* boundedBody(response).pipe(
                Effect.catch((error) => {
                  if (isOperationError(error)) {
                    operation?.abort(error.kind);
                  }
                  return Effect.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.DecodeError({ cause: error, request, response }),
                    }),
                  );
                }),
              );
          const headers = new Headers(response.headers);
          headers.delete("set-cookie");
          for (const cookie of Cookies.toSetCookieHeaders(response.cookies)) {
            headers.append("set-cookie", cookie);
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response([204, 205, 304].includes(response.status) ? null : bytes, {
              headers,
              status: response.status,
            }),
          );
        }),
      ),
    ),
    client.preprocess,
  );

export const storefrontHttpClientLayer = Layer.effect(
  HttpClient.HttpClient,
  HttpClient.HttpClient.pipe(Effect.map(boundOwnerClient)),
).pipe(Layer.provide(FetchHttpClient.layer));
