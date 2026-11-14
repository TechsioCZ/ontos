import { afterEach, rs } from "@rstest/core";
import { Context, Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect, it } from "effect-rstest";
import { portalWeb } from "../src/ontos/portal-http";
import { PortalOutcomeSchema, PortalRefusedProblem } from "../src/ontos/portal";

rs.mock("server-only", () => ({}));
afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllEnvs();
});

it.effect(
  "identifies a BFF origin refusal without sending enrollment or exposing request data",
  () =>
    Effect.gen(function* originRefusalDiagnostic() {
      const secret = "private-portal-diagnostic-sentinel";
      let upstreamCalls = 0;
      const fetch: typeof globalThis.fetch = () => {
        upstreamCalls += 1;
        return Promise.resolve(Response.json({ private: secret }));
      };
      const response = yield* Effect.promise(() =>
        portalWeb.handler(
          new Request("https://n1.example/api/enrollment", {
            body: JSON.stringify({
              email: `${secret}@example.test`,
              firstName: "Private",
              lastName: "Person",
              password: secret,
              passwordConfirmation: secret,
              requestId: "71000000-0000-4000-8000-000000000099",
              termsAccepted: true,
            }),
            headers: {
              "content-type": "application/json",
              cookie: `commerce-portal.session_token=${secret}`,
              origin: "https://foreign.example",
            },
            method: "POST",
          }),
          Context.make(FetchHttpClient.Fetch, fetch),
        ),
      );
      const body = yield* Effect.promise(() => response.text());
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(PortalRefusedProblem), {
          onExcessProperty: "error",
        })(body),
      ).toEqual(
        PortalRefusedProblem.make({
          detail: "Portal account request could not be completed.",
          diagnostic: "bff-origin-refused",
          state: "refused",
          status: 403,
          title: "Portal account",
          type: "urn:n1:portal-account",
        }),
      );
      expect(upstreamCalls).toBe(0);
      expect(body).not.toContain(secret);
      expect(body).not.toContain("71000000-0000-4000-8000-000000000099");
      expect(body).not.toContain("https://foreign.example");
    }),
);

const origin = "https://n1.example";
const secret = "private-portal-refusal-sentinel";
const registration = {
  email: `${secret}@example.test`,
  firstName: "Private",
  lastName: "Person",
  password: secret,
  passwordConfirmation: secret,
  requestId: "71000000-0000-4000-8000-000000000099",
  termsAccepted: true,
} as const;
const configure = () => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "private-refusal-api-key");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", "71000000-0000-4000-8000-000000000098");
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000097");
  rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
};
const registrationRequest = () =>
  new Request(`${origin}/api/enrollment`, {
    body: JSON.stringify(registration),
    headers: {
      "content-type": "application/json",
      cookie: `commerce-portal.session_token=${secret}`,
      origin,
    },
    method: "POST",
  });

for (const [failure, diagnostic, status, expectedCalls] of [
  ["gateway-forbidden", "gateway-context-forbidden", 403, 1],
  ["origin_not_trusted", "owner-origin-not-trusted", 403, 2],
  ["enrollment_rejected", "owner-enrollment-rejected", 403, 2],
  ["journey-unavailable", "owner-journey-unavailable", 403, 2],
  ["unknown", undefined, 503, 2],
] as const) {
  it.effect(
    `keeps the public refusal generic and projects only its finite ${failure} boundary`,
    () =>
      Effect.gen(function* typedRefusalWireBoundary() {
        configure();
        const paths: string[] = [];
        const fetch: typeof globalThis.fetch = (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path.endsWith("/gateway-context") && failure !== "gateway-forbidden") {
            return Promise.resolve(
              Response.json({
                apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
                compositionRevision: "a".repeat(64),
                expiresAt: 9_999_999_999,
                token: secret,
              }),
            );
          }
          const journey = failure === "journey-unavailable";
          let code: string = failure;
          if (failure === "unknown") {
            code = secret;
          } else if (journey) {
            code = "enrollment_journey_unavailable";
          }
          return Promise.resolve(
            Response.json(
              {
                _tag: journey
                  ? "CommercePortalAuthEnrollmentJourneyUnavailableProblem"
                  : "CommercePortalAuthEnrollmentForbiddenProblem",
                code,
                detail: JSON.stringify({
                  cause: secret,
                  cookie: secret,
                  email: registration.email,
                  password: secret,
                  providerAccountReason: secret,
                }),
                status: journey ? 422 : 403,
                title: secret,
                type: "urn:test:private-owner-refusal",
              },
              { headers: { "x-private-upstream": secret }, status: journey ? 422 : 403 },
            ),
          );
        };
        const response = yield* Effect.promise(() =>
          portalWeb.handler(registrationRequest(), Context.make(FetchHttpClient.Fetch, fetch)),
        );
        const body = yield* Effect.promise(() => response.text());
        const decoded = JSON.parse(body);
        expect(response.status).toBe(status);
        expect(decoded.status).toBe(status);
        expect(decoded.state).toBe(status === 403 ? "refused" : "unconfirmed");
        expect(decoded.diagnostic).toBe(diagnostic);
        if (diagnostic === undefined) {
          expect(Object.hasOwn(decoded, "diagnostic")).toBe(false);
        }
        expect(decoded.detail).toBe("Portal account request could not be completed.");
        expect(decoded.title).toBe("Portal account");
        expect(decoded.type).toBe("urn:n1:portal-account");
        expect(paths).toHaveLength(expectedCalls);
        expect(paths.filter((path) => path.endsWith("/enrollment/start"))).toHaveLength(
          expectedCalls - 1,
        );
        expect(body).not.toContain(secret);
        expect(body).not.toContain(registration.requestId);
        expect(body).not.toContain("providerAccountReason");
        expect(response.headers.get("x-private-upstream")).toBeNull();
      }),
  );
}

it.effect("does not invent a refusal diagnostic for invalid input in the known N1 scope", () =>
  Effect.gen(function* invalidInputHasNoRefusalDiagnostic() {
    configure();
    let upstreamCalls = 0;
    const fetch: typeof globalThis.fetch = () => {
      upstreamCalls += 1;
      return Promise.resolve(Response.json({ private: secret }));
    };
    const response = yield* Effect.promise(() =>
      portalWeb.handler(
        new Request(`${origin}/api/enrollment`, {
          body: JSON.stringify({ ...registration, termsAccepted: false }),
          headers: { "content-type": "application/json", origin },
          method: "POST",
        }),
        Context.make(FetchHttpClient.Fetch, fetch),
      ),
    );
    const body = yield* Effect.promise(() => response.json());
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ state: "invalid", status: 400 });
    expect(Object.hasOwn(body, "diagnostic")).toBe(false);
    expect(upstreamCalls).toBe(0);
  }),
);

it("keeps old refused contracts valid and rejects unknown or misplaced diagnostic values", () => {
  const legacy = {
    _tag: "PortalRefusedProblem",
    detail: "Portal account request could not be completed.",
    state: "refused",
    status: 403,
    title: "Portal account",
    type: "urn:n1:portal-account",
  };
  const decode = Schema.decodeUnknownOption(PortalRefusedProblem, { onExcessProperty: "error" });
  expect(Option.isSome(decode(legacy))).toBe(true);
  expect(Option.isSome(decode({ ...legacy, diagnostic: "owner-enrollment-rejected" }))).toBe(true);
  expect(Option.isNone(decode({ ...legacy, diagnostic: secret }))).toBe(true);
  const outcome = Schema.decodeUnknownOption(PortalOutcomeSchema, { onExcessProperty: "error" });
  expect(Option.isSome(outcome({ state: "refused" }))).toBe(true);
  expect(
    Option.isNone(outcome({ diagnostic: "owner-enrollment-rejected", state: "unconfirmed" })),
  ).toBe(true);
});
