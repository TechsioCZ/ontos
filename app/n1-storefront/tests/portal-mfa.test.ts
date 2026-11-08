import { afterEach, rs } from "@rstest/core";
import { Context, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import { portalWeb } from "../src/ontos/portal-http";

rs.mock("server-only", () => ({}));
afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllEnvs();
});

const origin = "https://n1.example";
const code = "private-mfa-code";
const tenantId = "71000000-0000-4000-8000-000000000098";
const configure = () => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "test-mfa-api-key");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", tenantId);
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000097");
  rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
};
const gateway = () =>
  Response.json({
    apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
    compositionRevision: "a".repeat(64),
    expiresAt: 9_999_999_999,
    token: "test-mfa-assertion",
  });
interface MfaRequestFixture {
  readonly code?: string;
  readonly customerId?: string;
  readonly method?: string;
  readonly trustDevice?: boolean;
}
const mfaRequest = (
  action: "request" | "verify",
  payload: MfaRequestFixture,
  requestOrigin = origin,
) =>
  new Request(`${origin}/api/account/mfa/${action}`, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      cookie: "staff.session=private; __Secure-commerce-portal.two_factor=pending",
      origin: requestOrigin,
    },
    method: "POST",
  });

describe("N1 MFA ongoing-login boundary", () => {
  for (const [action, payload] of [
    ["request", { trustDevice: true }],
    ["verify", { code, method: "backup" }],
    ["verify", { code, customerId: "attacker", method: "totp" }],
    ["verify", { code: " padded ", method: "totp" }],
    ["verify", { code: "a".repeat(33), method: "totp" }],
  ] as const) {
    it.effect(`rejects invalid ${action} input without dispatch or secret echo`, () =>
      Effect.gen(function* invalidMfaInput() {
        let calls = 0;
        const fetch: typeof globalThis.fetch = () => {
          calls += 1;
          return Promise.resolve(gateway());
        };
        const response = yield* Effect.promise(() =>
          portalWeb.handler(
            mfaRequest(action, payload),
            Context.make(FetchHttpClient.Fetch, fetch),
          ),
        );
        expect(response.status).toBe(400);
        expect(calls).toBe(0);
        expect(yield* Effect.promise(() => response.text())).not.toContain(code);
      }),
    );
  }

  it.effect("finishes TOTP with rotated cookies and a separate fresh native admission", () =>
    Effect.gen(function* nativeMfaAdmission() {
      configure();
      const requests: Request[] = [];
      const bodies: unknown[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/gateway-context")) {
          return gateway();
        }
        if (path.endsWith("/verify-totp")) {
          bodies.push(await request.json());
          return Response.json(
            { status: true },
            {
              headers: {
                "set-cookie":
                  "__Secure-commerce-portal.session_token=verified; HttpOnly; Secure; Path=/",
              },
            },
          );
        }
        return Response.json({
          account: {
            email: "shopper@example.test",
            id: "native-subject",
            name: "Shopper",
            partyId: "71000000-0000-4000-8000-000000000096",
            tenantId,
          },
          state: "authenticated",
        });
      };
      const response = yield* Effect.promise(() =>
        portalWeb.handler(
          mfaRequest("verify", { code, method: "totp" }),
          Context.make(FetchHttpClient.Fetch, fetch),
        ),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        outcome: { email: "shopper@example.test", name: "Shopper", state: "admitted" },
        state: "complete",
      });
      expect(bodies).toEqual([{ code, trustDevice: false }]);
      const ownerRequests = requests.filter((request) => !request.url.endsWith("/gateway-context"));
      expect(ownerRequests).toHaveLength(2);
      expect(ownerRequests[0]?.headers.get("cookie")).toBe(
        "__Secure-commerce-portal.two_factor=pending",
      );
      expect(ownerRequests[1]?.headers.get("cookie")).toContain(
        "__Secure-commerce-portal.session_token=verified",
      );
      expect(response.headers.get("set-cookie")).toContain(
        "__Secure-commerce-portal.session_token=verified",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    }),
  );
});

for (const [nativeCode, nativeTag, status, reason] of [
  ["invalid_request", "CommercePortalAuthMfaInvalidProblem", 400, "invalid"],
  ["mfa_rejected", "CommercePortalAuthMfaAuthenticationProblem", 401, "rejected"],
  ["mfa_challenge_expired", "CommercePortalAuthMfaAuthenticationProblem", 401, "expired"],
  [
    "mfa_authentication_not_fresh",
    "CommercePortalAuthMfaAuthenticationProblem",
    401,
    "authentication-required",
  ],
  ["MFA_RATE_LIMITED", "CommercePortalAuthMfaRateLimitedProblem", 429, "throttled"],
  ["origin_not_trusted", "CommercePortalAuthMfaForbiddenProblem", 403, "refused"],
  ["authentication_unavailable", "CommercePortalAuthMfaUnavailableProblem", 503, "unavailable"],
] as const) {
  it.effect(`preserves ${nativeCode} and realm expiry without leaking the native body`, () =>
    Effect.gen(function* nativeMfaProblem() {
      configure();
      let writes = 0;
      const fetch: typeof globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/gateway-context")) {
          return Promise.resolve(gateway());
        }
        writes += 1;
        const problemBody = {
          _tag: nativeTag,
          code: nativeCode,
          detail: code,
          status,
          title: code,
          type: "urn:test:mfa",
        };
        const body = status === 503 ? { ...problemBody, retryable: true } : problemBody;
        return Promise.resolve(
          Response.json(body, {
            headers: {
              "set-cookie":
                "__Secure-commerce-portal.two_factor=; Path=/; HttpOnly; Secure; Max-Age=0",
            },
            status,
          }),
        );
      };
      const response = yield* Effect.promise(() =>
        portalWeb.handler(
          mfaRequest("verify", { code, method: "otp" }),
          Context.make(FetchHttpClient.Fetch, fetch),
        ),
      );
      expect(response.status).toBe(status);
      const body = yield* Effect.promise(() => response.text());
      expect(JSON.parse(body)).toMatchObject({ reason, state: "mfa-error", status });
      expect(body).not.toContain(code);
      expect(body).not.toContain("retryAfterSeconds");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(writes).toBe(1);
    }),
  );
}

for (const sent of [true, false]) {
  it.effect(`only confirms OTP delivery acknowledgement when native status is ${sent}`, () =>
    Effect.gen(function* explicitOtpAcknowledgement() {
      configure();
      const paths: string[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        paths.push(new URL(request.url).pathname);
        if (request.url.endsWith("/gateway-context")) {
          return gateway();
        }
        expect(request.url).toContain("/two-factor/send-otp");
        expect(await request.json()).toEqual({ trustDevice: false });
        return Response.json({ status: sent });
      };
      const response = yield* Effect.promise(() =>
        portalWeb.handler(mfaRequest("request", {}), Context.make(FetchHttpClient.Fetch, fetch)),
      );
      expect(response.status).toBe(sent ? 200 : 503);
      expect(yield* Effect.promise(() => response.json())).toMatchObject(
        sent ? { state: "otp-sent" } : { reason: "unconfirmed", state: "mfa-error" },
      );
      expect(paths).toHaveLength(2);
    }),
  );
}

for (const admission of ["anonymous", "foreign", "malformed"] as const) {
  it.effect(`does not equate a consumed challenge with ${admission} customer admission`, () =>
    Effect.gen(function* missingAdmissionAfterMfa() {
      configure();
      let writes = 0;
      const fetch: typeof globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/gateway-context")) {
          return Promise.resolve(gateway());
        }
        if (request.url.endsWith("/verify-otp")) {
          writes += 1;
          return Promise.resolve(
            Response.json(
              { status: true },
              {
                headers: {
                  "set-cookie": "__Secure-commerce-portal.session_token=consumed; HttpOnly; Path=/",
                },
              },
            ),
          );
        }
        const body =
          admission === "foreign"
            ? {
                account: {
                  email: "other@example.test",
                  id: "other-subject",
                  name: "Other",
                  partyId: "71000000-0000-4000-8000-000000000096",
                  tenantId: "71000000-0000-4000-8000-000000000095",
                },
                state: "authenticated",
              }
            : { state: admission };
        return Promise.resolve(Response.json(body));
      };
      const response = yield* Effect.promise(() =>
        portalWeb.handler(
          mfaRequest("verify", { code, method: "otp" }),
          Context.make(FetchHttpClient.Fetch, fetch),
        ),
      );
      expect(response.status).toBe(503);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        reason: "unconfirmed",
        state: "mfa-error",
      });
      expect(writes).toBe(1);
      expect(response.headers.get("set-cookie")).toContain("session_token=consumed");
    }),
  );
}

for (const action of ["request", "verify"] as const) {
  it.effect(`rejects foreign Origin for ${action} before body decoding or native dispatch`, () =>
    Effect.gen(function* mfaOriginBoundary() {
      let calls = 0;
      const fetch: typeof globalThis.fetch = () => {
        calls += 1;
        return Promise.resolve(gateway());
      };
      const response = yield* Effect.promise(() =>
        portalWeb.handler(
          mfaRequest(action, { code, method: "totp" }, "https://foreign.example"),
          Context.make(FetchHttpClient.Fetch, fetch),
        ),
      );
      expect(response.status).toBe(403);
      expect(calls).toBe(0);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(yield* Effect.promise(() => response.text())).not.toContain(code);
    }),
  );
}
