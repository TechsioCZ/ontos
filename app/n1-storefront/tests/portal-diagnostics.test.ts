import { afterEach, rs } from "@rstest/core";
import { Effect, Logger, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import {
  currentPortalServer,
  portalFailureOutcome,
  portalRequestContext,
  registerPortalServer,
} from "../src/ontos/portal-server";

rs.mock("server-only", () => ({}));
afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllEnvs();
});

const origin = "https://n1.example";
const sentinels = [
  "private-password-sentinel",
  "private-person@example.test",
  "private-cookie-sentinel",
  "private-assertion-sentinel",
  "private-cause-sentinel",
] as const;
const registration = {
  email: sentinels[1],
  firstName: "Private",
  lastName: "Person",
  password: sentinels[0],
  passwordConfirmation: sentinels[0],
  requestId: "71000000-0000-4000-8000-000000000099",
  termsAccepted: true,
} as const;
const configure = () => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "private-api-key-sentinel");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", "71000000-0000-4000-8000-000000000098");
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000097");
  rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
};
type CapturedLog = ReturnType<typeof Logger.formatStructured.log>;
const collectLogs = (logs: CapturedLog[]) =>
  Logger.layer([
    Logger.make((options) => {
      logs.push(Logger.formatStructured.log(options));
    }),
  ]);
const backend = (code: string, gatewayForbidden = false) => {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    paths.push(path);
    if (path.endsWith("/gateway-context") && !gatewayForbidden) {
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: sentinels[3],
      });
    }
    if (path.endsWith("/customer-account")) {
      return Response.json({ state: "anonymous" });
    }
    return Response.json(
      {
        _tag: "CommercePortalAuthEnrollmentForbiddenProblem",
        code,
        detail: JSON.stringify({
          cause: { nested: sentinels[4] },
          cookie: sentinels[2],
          email: sentinels[1],
          password: sentinels[0],
          token: sentinels[3],
        }),
        status: 403,
        title: "Private upstream refusal",
        type: "urn:test:portal-refusal",
      },
      { status: 403 },
    );
  };
  return { fetch, paths };
};
const expectPrivateLogs = (logs: readonly CapturedLog[]) => {
  const serialized = JSON.stringify(logs);
  for (const sentinel of [...sentinels, "private-api-key-sentinel", registration.requestId]) {
    expect(serialized).not.toContain(sentinel);
  }
  expect(serialized).not.toContain("Private upstream refusal");
  expect(logs.every((log) => log.cause === undefined)).toBe(true);
};

describe("finite server-only Portal diagnostics", () => {
  for (const code of ["origin_not_trusted", "enrollment_rejected"] as const) {
    it.effect(`retains only ${code} for one native enrollment refusal`, () =>
      Effect.gen(function* enrollmentRefusalDiagnostic() {
        configure();
        const service = backend(code);
        const logs: CapturedLog[] = [];
        const result = yield* registerPortalServer(
          registration,
          portalRequestContext(origin, `commerce-portal.session_token=${sentinels[2]}`),
        ).pipe(
          Effect.result,
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(collectLogs(logs)),
          Effect.provideService(FetchHttpClient.Fetch, service.fetch),
        );
        expect(
          Result.isFailure(result) ? portalFailureOutcome(result.failure) : result.success,
        ).toEqual({
          state: "refused",
        });
        expect(service.paths.filter((path) => path.endsWith("/enrollment/start"))).toHaveLength(1);
        expect(logs).toHaveLength(1);
        expect(logs[0]?.annotations).toEqual({ operation: "enrollment-start", reason: code });
        expectPrivateLogs(logs);
      }),
    );
  }

  it.effect("distinguishes a gateway refusal without dispatching enrollment", () =>
    Effect.gen(function* gatewayRefusalDiagnostic() {
      configure();
      const service = backend("origin_not_trusted", true);
      const logs: CapturedLog[] = [];
      const result = yield* registerPortalServer(
        registration,
        portalRequestContext(origin, ""),
      ).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(collectLogs(logs)),
        Effect.provideService(FetchHttpClient.Fetch, service.fetch),
      );
      expect(
        Result.isFailure(result) ? portalFailureOutcome(result.failure) : result.success,
      ).toEqual({
        state: "refused",
      });
      expect(service.paths).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.annotations).toEqual({ operation: "gateway-context", reason: "forbidden" });
      expectPrivateLogs(logs);
    }),
  );

  it.effect("projects an explicit native resume refusal without retrying it", () =>
    Effect.gen(function* resumeRefusalDiagnostic() {
      configure();
      const service = backend("enrollment_rejected");
      const logs: CapturedLog[] = [];
      const result = yield* currentPortalServer(
        portalRequestContext(origin, `commerce-portal.session_token=${sentinels[2]}`),
        true,
      ).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(collectLogs(logs)),
        Effect.provideService(FetchHttpClient.Fetch, service.fetch),
      );
      expect(
        Result.isFailure(result) ? portalFailureOutcome(result.failure) : result.success,
      ).toEqual({
        state: "refused",
      });
      expect(
        service.paths.filter((path) => path.endsWith("/enrollment/current/resume")),
      ).toHaveLength(1);
      expect(service.paths.some((path) => path.endsWith("/enrollment/start"))).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.annotations).toEqual({
        operation: "enrollment-resume",
        reason: "enrollment_rejected",
      });
      expectPrivateLogs(logs);
    }),
  );

  it.effect("does not log an unrecognized upstream problem code or its body", () =>
    Effect.gen(function* unknownProblemDiagnostic() {
      configure();
      const service = backend(sentinels[4]);
      const logs: CapturedLog[] = [];
      const result = yield* registerPortalServer(
        registration,
        portalRequestContext(origin, ""),
      ).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(collectLogs(logs)),
        Effect.provideService(FetchHttpClient.Fetch, service.fetch),
      );
      expect(
        Result.isFailure(result) ? portalFailureOutcome(result.failure) : result.success,
      ).toEqual({
        state: "unconfirmed",
      });
      expect(service.paths.filter((path) => path.endsWith("/enrollment/start"))).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.annotations).toEqual({ operation: "enrollment-start", reason: "other" });
      expectPrivateLogs(logs);
    }),
  );
});
