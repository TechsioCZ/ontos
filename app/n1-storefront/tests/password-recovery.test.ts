import { afterEach, describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Context, Effect, Redacted, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import type { StorefrontConfiguration } from "../src/ontos/config";
import {
  acceptPasswordRecoveryWithConfiguration,
  hasPasswordRecoveryToken,
  recoveryCookieName,
  requestPasswordRecoveryWithConfiguration,
  resetPasswordRecoveryWithConfiguration,
} from "../src/ontos/password-recovery-server";
import { passwordRecoveryWeb } from "../src/ontos/password-recovery-http";

const origin = "https://n1.example";
const token = "test-only-reset-token";
const cookie = `${recoveryCookieName}=${token}`;
const reset = {
  newPassword: "x".repeat(16),
  passwordConfirmation: "x".repeat(16),
};
const config = {
  apiKey: "test-only-recovery-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "71000000-0000-4000-8000-000000000098",
} satisfies StorefrontConfiguration;
afterEach(() => {
  rs.unstubAllEnvs();
});
interface BackendOptions {
  readonly gatewayRefusal?: boolean;
  readonly malformed?: boolean;
  readonly reconciliation?: boolean;
  readonly status?: 400 | 403 | 429 | 503;
}
const backend = (options: BackendOptions = {}) => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    if (request.url.endsWith("/gateway-context")) {
      return options.gatewayRefusal === true
        ? Response.json({}, { status: 403 })
        : Response.json({
            apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
            compositionRevision: "a".repeat(64),
            expiresAt: 9_999_999_999,
            token: "test-only-recovery-assertion",
          });
    }
    if (options.status !== undefined) {
      const problems = {
        400: { _tag: "CommercePortalAuthRecoveryRejectedProblem", code: "INVALID_TOKEN" },
        403: { _tag: "CommercePortalAuthRecoveryForbiddenProblem", code: "invalid_callback_url" },
        429: { _tag: "CommercePortalAuthRecoveryRateLimitedProblem", code: "rate_limited" },
        503: {
          _tag: "CommercePortalAuthRecoveryUnavailableProblem",
          code: "authentication_unavailable",
          retryable: true,
        },
      };
      return Response.json(
        {
          ...problems[options.status],
          detail: "Recovery unavailable",
          status: options.status,
          title: "Recovery",
          type: "urn:test:recovery",
        },
        { headers: { "content-type": "application/problem+json" }, status: options.status },
      );
    }
    if (options.malformed === true) {
      return Response.json({ token: "must-not-escape" });
    }
    if (request.method === "GET") {
      return Response.json({
        callbackURL: "https://untrusted.example/ignored",
        outcome: "PASSWORD_RESET_PENDING",
      });
    }
    if (request.url.endsWith("/request-password-reset")) {
      return Response.json({ outcome: "ACCOUNT_RECOVERY_STARTED" });
    }
    if (options.reconciliation === true) {
      return Response.json({
        conflictClass: "IDENTIFIER_REBOUND",
        outcome: "ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED",
      });
    }
    return Response.json({ outcome: "ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT" });
  };
  return { calls, context: Context.make(FetchHttpClient.Fetch, fetch), fetch };
};
const withBackend = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  owner: ReturnType<typeof backend>,
) =>
  program.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
  );
const configure = () => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", config.apiKey);
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", config.tenantId);
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", config.legalEntityId);
  rs.stubEnv("ONTOS_SHELL_URL", config.shellUrl);
};
const post = (
  path: "request" | "reset",
  payload: Readonly<Record<string, string>>,
  requestOrigin: string = origin,
) =>
  new Request(`${origin}/api/account/password/${path}`, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      cookie: `staff.session=never-forward; ${cookie}`,
      origin: requestOrigin,
    },
    method: "POST",
  });
const call = (request: Request, owner: ReturnType<typeof backend>) =>
  Effect.promise(() => passwordRecoveryWeb.handler(request, owner.context));

describe("native password recovery", () => {
  it.effect("answers identically for known and unknown email without account lookup", () =>
    Effect.gen(function* antiEnumeration() {
      for (const email of ["known@example.test", "unknown@example.test"]) {
        const owner = backend();
        const result = yield* withBackend(
          requestPasswordRecoveryWithConfiguration(config, { email }, origin),
          owner,
        );
        expect(result).toEqual({ state: "requested" });
        expect(owner.calls).toHaveLength(2);
        const [, request] = owner.calls;
        expect(request?.headers.get("cookie")).toBeNull();
        expect(request?.headers.get("origin")).toBe(origin);
        expect(yield* Effect.promise(async () => await request?.json())).toEqual({ email });
      }
    }),
  );
  it.effect("passes a redacted callback secret internally without exposing a redirect target", () =>
    Effect.gen(function* secretCallback() {
      const owner = backend();
      const result = yield* withBackend(
        acceptPasswordRecoveryWithConfiguration(config, token, "/safe"),
        owner,
      );
      expect(Redacted.value(result)).toBe(token);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(owner.calls[1]?.headers.get("cookie")).toBeNull();
      expect(owner.calls[1]?.headers.get("origin")).toBeNull();
      expect(new URL(owner.calls[1]?.url ?? origin).searchParams.get("callbackURL")).toBe("/safe");
    }),
  );
  it.effect("resets once through the native owner and preserves reconciliation", () =>
    Effect.gen(function* nativeReset() {
      for (const reconciliation of [false, true]) {
        const owner = backend({ reconciliation });
        const result = yield* withBackend(
          resetPasswordRecoveryWithConfiguration(config, reset, cookie, origin),
          owner,
        );
        expect(result).toEqual({ state: reconciliation ? "reconciliation" : "completed" });
        expect(owner.calls).toHaveLength(2);
        expect(yield* Effect.promise(async () => await owner.calls[1]?.json())).toEqual({
          newPassword: reset.newPassword,
          token,
        });
        expect(owner.calls[1]?.headers.get("cookie")).toBeNull();
      }
    }),
  );
  it.effect("rejects mismatched passwords and missing token without owner I/O", () =>
    Effect.gen(function* inputValidation() {
      const owner = backend();
      const mismatch = yield* withBackend(
        resetPasswordRecoveryWithConfiguration(
          config,
          { ...reset, passwordConfirmation: "y".repeat(16) },
          cookie,
          origin,
        ).pipe(Effect.result),
        owner,
      );
      const absent = yield* withBackend(
        resetPasswordRecoveryWithConfiguration(config, reset, "", origin).pipe(Effect.result),
        owner,
      );
      expect(Result.isFailure(mismatch)).toBe(true);
      expect(Result.isFailure(absent)).toBe(true);
      expect(owner.calls).toHaveLength(0);
      expect(hasPasswordRecoveryToken(cookie)).toBe(true);
      expect(hasPasswordRecoveryToken("")).toBe(false);
    }),
  );
  it.effect("rejects both identical and different duplicate reset cookies before native I/O", () =>
    Effect.gen(function* ambiguousResetCredential() {
      for (const second of [token, "different-test-only-token"]) {
        const owner = backend();
        const ambiguous = `${cookie}; ${recoveryCookieName}=${second}`;
        const result = yield* withBackend(
          resetPasswordRecoveryWithConfiguration(config, reset, ambiguous, origin).pipe(
            Effect.result,
          ),
          owner,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe("invalid-token");
        }
        expect(hasPasswordRecoveryToken(ambiguous)).toBe(false);
        expect(owner.calls).toHaveLength(0);
      }
    }),
  );
  for (const scenario of [
    { state: "invalid-token", status: 400 },
    { state: "forbidden", status: 403 },
    { state: "rate-limited", status: 429 },
    { state: "unconfirmed", status: 503 },
  ] satisfies readonly { state: string; status: BackendOptions["status"] }[]) {
    it.effect(`maps native status ${scenario.status} without retry or raw details`, () =>
      Effect.gen(function* nativeFailure() {
        const owner = backend({ status: scenario.status });
        const result = yield* withBackend(
          resetPasswordRecoveryWithConfiguration(config, reset, cookie, origin).pipe(Effect.result),
          owner,
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe(scenario.state);
          expect(JSON.stringify(result.failure)).not.toContain(token);
        }
        expect(owner.calls).toHaveLength(2);
      }),
    );
  }
  it.effect("keeps malformed post-dispatch success unconfirmed and never resends", () =>
    Effect.gen(function* malformedReset() {
      const owner = backend({ malformed: true });
      const result = yield* withBackend(
        resetPasswordRecoveryWithConfiguration(config, reset, cookie, origin).pipe(Effect.result),
        owner,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe("unconfirmed");
      }
      expect(owner.calls).toHaveLength(2);
    }),
  );
  it.effect("separates an unavailable gateway before dispatch from an unconfirmed write", () =>
    Effect.gen(function* gatewayFailure() {
      const owner = backend({ gatewayRefusal: true });
      const result = yield* withBackend(
        resetPasswordRecoveryWithConfiguration(config, reset, cookie, origin).pipe(Effect.result),
        owner,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe("unavailable");
      }
      expect(owner.calls).toHaveLength(1);
    }),
  );
});

describe("password recovery browser boundary", () => {
  it.effect("rejects an external-origin reset even with a valid recovery cookie", () =>
    Effect.gen(function* crossSiteCookieIsNotAuthority() {
      configure();
      const owner = backend();
      const request = post("reset", reset, "http://localhost:3099");
      expect(request.headers.get("cookie")).toContain(cookie);
      const response = yield* call(request, owner);
      expect(response.status).toBe(403);
      expect(owner.calls).toHaveLength(0);
      expect(response.headers.get("set-cookie")).toBeNull();
    }),
  );
  it.effect("does not retain a token when native callback validation refuses its target", () =>
    Effect.gen(function* refusedCallback() {
      configure();
      const owner = backend({ status: 403 });
      const response = yield* call(
        new Request(
          `${origin}/commerce-customer-context-api/api/portal-auth/reset-password/${token}?callbackURL=https%3A%2F%2Fforeign.example`,
        ),
        owner,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/cs/obnova-hesla");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(response.headers.get("set-cookie")).not.toContain(token);
      expect(owner.calls).toHaveLength(2);
    }),
  );
  it.effect(
    "allows the same short HttpOnly cookie on local HTTP without the Secure attribute",
    () =>
      Effect.gen(function* localCallbackCookie() {
        configure();
        const owner = backend();
        const response = yield* call(
          new Request(
            `http://localhost:3071/commerce-customer-context-api/api/portal-auth/reset-password/${token}`,
          ),
          owner,
        );
        expect(response.status).toBe(303);
        const setCookie = response.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).not.toContain("Secure");
        expect(setCookie).not.toContain("Domain=");
      }),
  );
  it.effect(
    "rejects token injection, extra fields and cross-origin requests before native I/O",
    () =>
      Effect.gen(function* closedRecoveryBody() {
        const owner = backend();
        for (const request of [
          post("reset", { ...reset, token }),
          post("request", { email: "known@example.test", redirectTo: origin }),
          post("reset", reset, "https://foreign.example"),
        ]) {
          const response = yield* call(request, owner);
          expect([400, 403]).toContain(response.status);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(yield* Effect.promise(() => response.text())).not.toContain(token);
        }
        expect(owner.calls).toHaveLength(0);
      }),
  );
  it.effect(
    "stores only a short host-only HttpOnly token cookie and strips token/owner redirect from Location",
    () =>
      Effect.gen(function* callbackCookie() {
        configure();
        const owner = backend();
        const response = yield* call(
          new Request(
            `${origin}/commerce-customer-context-api/api/portal-auth/reset-password/${token}?callbackURL=%2Fsafe`,
            { headers: { cookie: "staff.session=private" } },
          ),
          owner,
        );
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/cs/obnova-hesla");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        const setCookie = response.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain(`${recoveryCookieName}=${token}`);
        for (const attribute of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/", "Max-Age=600"]) {
          expect(setCookie).toContain(attribute);
        }
        expect(setCookie).not.toContain("Domain=");
        expect(yield* Effect.promise(() => response.text())).not.toContain(token);
      }),
  );
  it.effect(
    "clears the credential after completed, reconciliation, invalid token and uncertain writes",
    () =>
      Effect.gen(function* terminalCookie() {
        configure();
        for (const options of [
          {},
          { reconciliation: true },
          { status: 400 },
          { status: 503 },
          { malformed: true },
        ] satisfies readonly BackendOptions[]) {
          const owner = backend(options);
          const response = yield* call(post("reset", reset), owner);
          expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
          expect(response.headers.get("set-cookie")).not.toContain(token);
          expect(owner.calls).toHaveLength(2);
        }
      }),
  );
  it.effect(
    "keeps a token after local validation failure and refuses oversized or missing-Origin bodies",
    () =>
      Effect.gen(function* beforeDispatchRejection() {
        const owner = backend();
        const mismatch = yield* call(
          post("reset", { ...reset, passwordConfirmation: "y".repeat(16) }),
          owner,
        );
        expect(mismatch.status).toBe(400);
        expect(mismatch.headers.get("set-cookie")).toBeNull();
        const oversized = post("reset", reset);
        oversized.headers.set("content-length", "16385");
        const missingOrigin = post("request", { email: "known@example.test" });
        missingOrigin.headers.delete("origin");
        expect((yield* call(oversized, owner)).status).toBe(400);
        expect((yield* call(missingOrigin, owner)).status).toBe(403);
        expect(owner.calls).toHaveLength(0);
      }),
  );
  it.effect("redirects invalid callback queries safely without contacting an owner", () =>
    Effect.gen(function* closedCallback() {
      const owner = backend();
      for (const query of [
        "callbackURL=a&callbackURL=b",
        "token=injected",
        `callbackURL=${"a".repeat(2049)}`,
      ]) {
        const response = yield* call(
          new Request(
            `${origin}/commerce-customer-context-api/api/portal-auth/reset-password/${token}?${query}`,
          ),
          owner,
        );
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/cs/obnova-hesla");
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      }
      expect(owner.calls).toHaveLength(0);
    }),
  );
});
