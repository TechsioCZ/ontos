import { afterEach, rs } from "@rstest/core";
import { Context, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, it } from "effect-rstest";
import { portalWeb } from "../src/ontos/portal-http";
import { readConfiguration } from "../src/ontos/config";

rs.mock("server-only", () => ({}));
afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllEnvs();
});

for (const [ownerStatus, ownerOutcome, expected] of [
  [200, "EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT", "verified"],
  [200, "ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED", "reconciliation"],
  [503, "unavailable", "unconfirmed"],
] as const) {
  it.effect(`consumes a provider mail token once and fixes the landing after ${ownerOutcome}`, () =>
    Effect.gen(function* verificationWireBoundary() {
      rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "test-storefront-key");
      rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", "71000000-0000-4000-8000-000000000098");
      rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000099");
      rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
      yield* readConfiguration(process.env);
      const calls: { headers: Headers; method: string; url: URL }[] = [];
      const fetch: typeof globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push({ headers: request.headers, method: request.method, url });
        const gateway = url.pathname.endsWith("/auth/api-key/gateway-context");
        if (gateway) {
          return Promise.resolve(
            Response.json({
              apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
              compositionRevision: "a".repeat(64),
              expiresAt: 9_999_999_999,
              token: "test-audience-assertion",
            }),
          );
        }
        if (ownerStatus === 503) {
          return Promise.resolve(
            Response.json(
              {
                _tag: "CommercePortalAuthRecoveryUnavailableProblem",
                code: "authentication_unavailable",
                detail: "Unavailable",
                retryable: true,
                status: 503,
                title: "Unavailable",
                type: "urn:test:unavailable",
              },
              { status: 503 },
            ),
          );
        }
        const body =
          ownerOutcome === "ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED"
            ? { conflictClass: "VERIFICATION_LEDGER_SUBJECT_MISMATCH", outcome: ownerOutcome }
            : { outcome: ownerOutcome };
        return Promise.resolve(
          Response.json(body, {
            headers: {
              "set-cookie": "commerce-portal.session_token=must-not-be-relayed; Path=/; HttpOnly",
            },
          }),
        );
      };
      const response = yield* Effect.promise(
        async () =>
          await portalWeb.handler(
            new Request(
              "https://n1.example/commerce-customer-context-api/api/portal-auth/verify-email?token=test-token&callbackURL=https%3A%2F%2Fforeign.example",
              {
                headers: {
                  cookie: "staff.session=private; commerce-portal.session_token=private",
                  host: "n1.example",
                },
              },
            ),
            Context.make(FetchHttpClient.Fetch, fetch),
          ),
      );
      expect(calls).toHaveLength(2);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/cs/prihlaseni?verification=${expected}`);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(calls).toHaveLength(2);
      const [gateway, verification] = calls;
      expect(gateway?.headers.get("x-api-key")).toBe("test-storefront-key");
      expect(verification?.url.origin).toBe("https://shell.example");
      expect(verification?.url.pathname).toContain(
        "/shell-super-app-api/gateway/commerce-customer-context/",
      );
      expect(verification?.url.pathname).toContain("/api/portal-auth/verify-email");
      expect(verification?.url.searchParams.get("token")).toBe("test-token");
      expect(verification?.url.searchParams.has("callbackURL")).toBe(false);
      expect(verification?.headers.get("authorization")).toBe("Bearer test-audience-assertion");
      expect(verification?.headers.get("cookie")).toBeNull();
      expect(verification?.headers.get("origin")).toBeNull();
      expect(verification?.method).toBe("GET");
    }),
  );
}
