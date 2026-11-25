import { afterEach, beforeEach, rs } from "@rstest/core";
import { expect, it } from "effect-rstest";
import { ERROR_BYTES } from "@ontos/storefront-runtime";
import { Clock, Context, Effect, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { passwordRecoveryWeb } from "../src/ontos/password-recovery-http";
import { recoveryCookieName } from "../src/ontos/password-recovery-server";

beforeEach(() => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "recovery-test-key");
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000099");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", "71000000-0000-4000-8000-000000000098");
  rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
});
afterEach(() => {
  rs.unstubAllEnvs();
});

const request = (path: "reset" | "request") =>
  new Request(`https://n1.example/api/account/password/${path}`, {
    body: JSON.stringify(
      path === "reset"
        ? { newPassword: "x".repeat(16), passwordConfirmation: "x".repeat(16) }
        : { email: "shopper@example.test" },
    ),
    headers: {
      "content-type": "application/json",
      cookie: `staff.session=private; ${recoveryCookieName}=private-reset-token`,
      origin: "https://n1.example",
    },
    method: "POST",
  });

const recoveryTransport = (path: string, oversized = false) => {
  const started = Promise.withResolvers<null>();
  const release = Promise.withResolvers<null>();
  const calls: Request[] = [];
  let cancelled = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const outgoing = new Request(input, init);
    calls.push(outgoing);
    if (outgoing.url.endsWith("/gateway-context")) {
      expect(outgoing.headers.get("x-api-key")).toBe("recovery-test-key");
      expect(await outgoing.json()).toEqual({
        audience: "commerce-customer-context",
        legalEntityId: "71000000-0000-4000-8000-000000000099",
      });
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/portal",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: "recovery-test-assertion",
      });
    }
    expect(new URL(outgoing.url).pathname).toBe(
      `/shell-super-app-api/gateway/portal/api/portal-auth/${path}`,
    );
    expect(outgoing.headers.get("authorization")).toBe("Bearer recovery-test-assertion");
    expect(outgoing.headers.get("cookie")).toBeNull();
    if (path === "reset-password") {
      expect(outgoing.method).toBe("POST");
      expect(await outgoing.json()).toEqual({
        newPassword: "x".repeat(16),
        token: "private-reset-token",
      });
    } else if (path === "request-password-reset") {
      expect(outgoing.method).toBe("POST");
      expect(await outgoing.json()).toEqual({ email: "shopper@example.test" });
    } else {
      expect(outgoing.method).toBe("GET");
    }
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled = true;
            release.resolve(null);
          },
          async pull(controller) {
            started.resolve(null);
            if (oversized) {
              controller.enqueue(new Uint8Array(ERROR_BYTES + 1));
            } else {
              await release.promise;
            }
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: {
          "content-type": "application/json",
          "set-cookie": "staff.session=forbidden; Path=/; HttpOnly",
        },
        status: oversized ? 503 : 200,
      },
    );
  };
  return { calls, cancelled: () => cancelled, fetch, started: started.promise };
};

for (const kind of ["cancelled", "deadline", "body_oversize"] as const) {
  it.effect(`keeps reset ${kind} typed and clears the uncertain reset credential`, () =>
    Effect.gen(function* interruptedReset() {
      const caller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const transport = recoveryTransport("reset-password", kind === "body_oversize");
      const clock = yield* Clock.Clock;
      const context = Context.make(Clock.Clock, clock).pipe(
        Context.add(FetchHttpClient.Fetch, transport.fetch),
      );
      const pending = yield* Effect.forkChild(
        Effect.promise(() =>
          passwordRecoveryWeb.handler(
            new Request(request("reset"), { signal: caller.signal }),
            context,
          ),
        ),
      );
      yield* Effect.promise(() => transport.started);
      if (kind === "cancelled") {
        caller.abort();
      } else if (kind === "deadline") {
        yield* TestClock.adjust("30 seconds");
      }
      const response = yield* Fiber.join(pending);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("set-cookie")).toContain(`${recoveryCookieName}=`);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(response.headers.get("set-cookie")).not.toContain("private-reset-token");
      expect(response.headers.get("set-cookie")).not.toContain("staff.session");
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "PasswordRecoveryUnavailableProblem",
        state: "unconfirmed",
        status: 503,
      });
      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[1]?.signal.aborted).toBe(true);
      expect(transport.cancelled()).toBe(true);
    }).pipe(Effect.scoped),
  );
}

it.effect(
  "keeps an uncertain recovery request typed without deleting an unrelated reset token",
  () =>
    Effect.gen(function* interruptedRecoveryRequest() {
      const transport = recoveryTransport("request-password-reset");
      const clock = yield* Clock.Clock;
      const context = Context.make(Clock.Clock, clock).pipe(
        Context.add(FetchHttpClient.Fetch, transport.fetch),
      );
      const pending = yield* Effect.forkChild(
        Effect.promise(() => passwordRecoveryWeb.handler(request("request"), context)),
      );
      yield* Effect.promise(() => transport.started);
      yield* TestClock.adjust("30 seconds");
      const response = yield* Fiber.join(pending);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "PasswordRecoveryUnavailableProblem",
        state: "unconfirmed",
        status: 503,
      });
      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[1]?.signal.aborted).toBe(true);
      expect(transport.cancelled()).toBe(true);
    }),
);

it.effect("still redirects an interrupted callback safely and clears its token", () =>
  Effect.gen(function* interruptedRecoveryCallback() {
    const transport = recoveryTransport("reset-password/private-reset-token");
    const clock = yield* Clock.Clock;
    const context = Context.make(Clock.Clock, clock).pipe(
      Context.add(FetchHttpClient.Fetch, transport.fetch),
    );
    const pending = yield* Effect.forkChild(
      Effect.promise(() =>
        passwordRecoveryWeb.handler(
          new Request(
            "https://n1.example/commerce-customer-context-api/api/portal-auth/reset-password/private-reset-token",
          ),
          context,
        ),
      ),
    );
    yield* Effect.promise(() => transport.started);
    yield* TestClock.adjust("30 seconds");
    const response = yield* Fiber.join(pending);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/cs/obnova-hesla");
    expect(response.headers.get("x-storefront-failure")).toBe("deadline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("private-reset-token");
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]?.signal.aborted).toBe(true);
    expect(transport.cancelled()).toBe(true);
  }),
);
