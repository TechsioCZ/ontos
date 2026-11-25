import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "effect-rstest";
import { Effect, Fiber, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import { executeSubmitStorefrontInquiryWithAuthorization } from "@app/work-tasks/clients/submit-storefront-inquiry";
import { SubmitStorefrontInquiryPayloadSchema } from "@app/work-tasks/contracts/submit-storefront-inquiry";
import { executePlaceStorefrontOrderWithAuthorization } from "@app/merchandise/clients/place-storefront-order";
import { PlaceStorefrontOrderPayloadSchema } from "@app/merchandise/contracts/place-storefront-order";
import {
  createOperation,
  ERROR_BYTES,
  OWNER_WORK_LIMIT,
  RESPONSE_BYTES,
} from "@ontos/storefront-runtime";
import {
  boundOwnerClient,
  storefrontHttpClientLayer,
  withOwnerOperation,
} from "../src/ontos/owner-operation";

const requestId = "71000000-0000-4000-8000-000000000097";
const tenantId = "71000000-0000-4000-8000-000000000098";
const options = {
  baseUrl: "https://shell.example/shell-super-app-api/gateway",
  compositionRevision: "a".repeat(64),
  idempotencyKey: "one-native-dispatch",
  transformClient: boundOwnerClient,
};
const inquiry = (): Effect.Effect<unknown, unknown> =>
  Schema.decodeUnknownEffect(SubmitStorefrontInquiryPayloadSchema)({
    description: "Please contact me.",
    storefrontInquiry: {
      email: "buyer@example.test",
      kind: "CONTACT",
      message: "Please contact me.",
      name: "Buyer",
      requestId,
      subject: "Contact",
    },
    title: "Contact",
  }).pipe(
    Effect.flatMap((payload) =>
      executeSubmitStorefrontInquiryWithAuthorization(
        payload,
        "Bearer native-assertion",
        "native-correlation",
        options,
      ),
    ),
  );
const order = (): Effect.Effect<unknown, unknown> =>
  Schema.decodeUnknownEffect(PlaceStorefrontOrderPayloadSchema)({
    command: {
      _tag: "PlaceStorefrontOrder",
      clientRequestId: requestId,
      dryRun: true,
      expectedShippingPriceMinor: 0,
      lines: [{ expectedUnitPriceMinor: 100, productId: "product-1", quantity: 1 }],
      marketId: requestId,
      shippingMethod: "OSOBNI_ODBER",
    },
    expectedRevision: 0,
  }).pipe(
    Effect.flatMap((payload) =>
      executePlaceStorefrontOrderWithAuthorization(
        payload,
        "Bearer native-assertion",
        "native-correlation",
        options,
      ),
    ),
  );
const inquiryAction = {
  invoke: inquiry,
  name: "inquiry",
  path: "/work-tasks/actions/submit-storefront-inquiry",
  problem: "SubmitStorefrontInquiryActionForbiddenProblem",
  reply: {
    requestId,
    taskRef: {
      moduleId: "work.tasks",
      resourceId: "confirmed-inquiry",
      resourceType: "work.tasks.task",
      tenantId,
    },
  },
};
const orderAction = {
  invoke: order,
  name: "order",
  path: "/merchandise/actions/place-storefront-order",
  problem: "PlaceStorefrontOrderActionForbiddenProblem",
  reply: { entityIds: [], revision: 1 },
};
const actions: readonly {
  invoke: () => Effect.Effect<unknown, unknown>;
  name: string;
  path: string;
  problem: string;
  reply: unknown;
}[] = [inquiryAction, orderAction];
const run = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  fetch: typeof globalThis.fetch,
) =>
  program.pipe(
    Effect.provide(storefrontHttpClientLayer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

/** A pull-driven wire body, including whitespace JSON parsers would otherwise retain unboundedly. */
const streamed = (text: string, status = 200) => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          if (offset === bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 16_384, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "application/json" }, status },
  );
  return { cancelled: () => cancelled, consumed: () => offset, response };
};

describe("generated Actions use the native owner transport bounds", () => {
  for (const action of actions) {
    it.effect(
      `${action.name}: preserves decoded success, governed headers and exactly one dispatch`,
      () =>
        Effect.gen(function* generatedSuccess() {
          const calls: Request[] = [];
          const fetch: typeof globalThis.fetch = async (input, init) => {
            calls.push(new Request(input, init));
            return streamed(JSON.stringify(action.reply)).response;
          };
          const reply = yield* run(
            withOwnerOperation(action.invoke()).pipe(Effect.withSpan("generated-action-test")),
            fetch,
          );
          expect(reply).toEqual(action.reply);
          expect(calls).toHaveLength(1);
          const [request] = calls;
          if (request === undefined) {
            throw new Error("Missing native Action request");
          }
          expect(new URL(request.url).pathname).toBe(`/shell-super-app-api/gateway${action.path}`);
          expect(request.method).toBe("POST");
          expect(request.headers.get("authorization")).toBe("Bearer native-assertion");
          expect(request.headers.get("idempotency-key")).toBe(options.idempotencyKey);
          expect(request.headers.get("x-correlation-id")).toBe("native-correlation");
          expect(request.headers.get("x-ontos-composition-revision")).toBe(
            options.compositionRevision,
          );
          expect(request.headers.get("traceparent")).toBeNull();
          expect(request.headers.get("x-api-key")).toBeNull();
        }),
    );

    for (const status of [200, 403]) {
      it.effect(
        `${action.name}: bounds streaming ${status === 200 ? "success" : "error"} bytes before native decode`,
        () =>
          Effect.gen(function* generatedBodyLimit() {
            const limit = status === 200 ? RESPONSE_BYTES : ERROR_BYTES;
            const body =
              status === 200
                ? JSON.stringify(action.reply)
                : JSON.stringify({
                    _tag: action.problem,
                    code: "action_permission_denied",
                    detail: "Refused",
                    status,
                    title: "Action refused",
                    type: "https://ontos.dev/problems/action-refused",
                  });
            // Valid JSON on the old path, and multibyte UTF-8 inside the error body.
            const wire = streamed(
              status === 200
                ? body + " ".repeat(limit + 1)
                : body.replace("Refused", "ž".repeat(limit)) + " ".repeat(32_768),
              status,
            );
            let calls = 0;
            const fetch: typeof globalThis.fetch = async () => {
              calls += 1;
              return wire.response;
            };
            const result = yield* run(
              withOwnerOperation(action.invoke()).pipe(Effect.result),
              fetch,
            );
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { kind: "body_oversize" },
            });
            expect(calls).toBe(1);
            expect(wire.consumed()).toBeLessThanOrEqual(limit + 16_384);
            expect(wire.cancelled()).toBe(true);
          }),
      );
    }

    it.effect(`${action.name}: retains a bounded native tagged refusal without redispatch`, () =>
      Effect.gen(function* generatedRefusal() {
        let calls = 0;
        const fetch: typeof globalThis.fetch = async () => {
          calls += 1;
          return streamed(
            JSON.stringify({
              _tag: action.problem,
              code: "action_permission_denied",
              detail: "Refused",
              status: 403,
              title: "Action refused",
              type: "https://ontos.dev/problems/action-refused",
            }),
            403,
          ).response;
        };
        expect(
          yield* run(withOwnerOperation(action.invoke()).pipe(Effect.result), fetch),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: action.problem } });
        expect(calls).toBe(1);
      }),
    );
  }

  for (const stop of ["release", "cancelled", "deadline"] as const) {
    it.effect(`holds native work permits through streamed bodies: ${stop}`, () =>
      Effect.gen(function* generatedPermitLifetime() {
        const full = Promise.withResolvers<null>();
        const release = Promise.withResolvers<null>();
        const operation = yield* Effect.acquireRelease(createOperation(), (current) =>
          Effect.sync(current.dispose),
        );
        const requests: Request[] = [];
        let active = 0;
        let peak = 0;
        let cancelled = 0;
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          active += 1;
          peak = Math.max(peak, active);
          if (active === OWNER_WORK_LIMIT) {
            full.resolve(null);
          }
          const reply = request.url.endsWith("submit-storefront-inquiry")
            ? inquiryAction.reply
            : orderAction.reply;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled += 1;
                active -= 1;
              },
              async pull(controller) {
                await release.promise;
                // Cancellation may have closed the controller while this pull was waiting.
                if (operation.signal.aborted) {
                  return;
                }
                active -= 1;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(reply)));
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        };
        const total = OWNER_WORK_LIMIT + 3;
        const pending = yield* Effect.forkChild(
          run(
            withOwnerOperation(
              Effect.all(
                Array.from({ length: total }, (_, index) =>
                  (index % 2 === 0 ? inquiryAction : orderAction).invoke().pipe(Effect.asVoid),
                ),
                { concurrency: "unbounded" },
              ),
              { operation },
            ).pipe(Effect.result),
            fetch,
          ),
        );
        try {
          yield* Effect.promise(() => full.promise);
          // Let every runnable native client reach dispatch or the shared work queue.
          yield* Effect.promise(() => setImmediate());
          expect(requests).toHaveLength(OWNER_WORK_LIMIT);
          if (stop === "release") {
            release.resolve(null);
            expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Success" });
            expect(requests).toHaveLength(total);
          } else {
            operation.abort(stop);
            expect(yield* Fiber.join(pending)).toMatchObject({
              _tag: "Failure",
              failure: { kind: stop },
            });
            expect(requests).toHaveLength(OWNER_WORK_LIMIT);
            expect(cancelled).toBe(OWNER_WORK_LIMIT);
            expect(requests.every((request) => request.signal.aborted)).toBe(true);
          }
          expect(peak).toBe(OWNER_WORK_LIMIT);
          expect(active).toBe(0);
        } finally {
          operation.dispose();
          release.resolve(null);
          yield* Fiber.join(pending);
        }
      }).pipe(Effect.scoped),
    );
  }
});
