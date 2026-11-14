import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import type { StorefrontConfiguration } from "../src/ontos/config";
import {
  portalRequestContext,
  readPortalIdentityWithConfiguration,
} from "../src/ontos/portal-server";
import {
  readCustomerProfileWithConfiguration,
  updateCustomerProfileWithConfiguration,
} from "../src/ontos/customer-profile-server";
import type { CustomerProfile } from "../src/ontos/customer-profile";

const origin = "https://n1.example";
const config = {
  apiKey: "test-only-profile-service-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "71000000-0000-4000-8000-000000000098",
} satisfies StorefrontConfiguration;
const profile = {
  contactEmail: "contact@example.test",
  displayName: "Jan Novák",
  phone: "+420 777 123 456",
  version: "a".repeat(64),
} satisfies CustomerProfile;
const changed = { ...profile, displayName: "Jana Nováková" };
interface BackendOptions {
  readonly anonymous?: boolean;
  readonly foreignTenant?: boolean;
  readonly invalidUpdateReply?: boolean;
  readonly profileStatus?: 401 | 403 | 409 | 503;
}
const backend = (options: BackendOptions = {}) => {
  const calls: Request[] = [];
  let contexts = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("/gateway-context")) {
      contexts += 1;
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: `profile-assertion-${contexts}`,
      });
    }
    if (path.endsWith("/customer-account")) {
      const account = {
        email: "login@example.test",
        id: "provider-subject-1",
        name: "Jan Novák",
        partyId: "71000000-0000-4000-8000-000000000096",
        tenantId: options.foreignTenant === true ? config.legalEntityId : config.tenantId,
      };
      return Response.json(
        options.anonymous === true ? { state: "anonymous" } : { account, state: "authenticated" },
        {
          headers: {
            "set-cookie":
              "commerce-portal.session_token=rotated-session; Path=/; HttpOnly; SameSite=Lax",
          },
        },
      );
    }
    if (options.profileStatus !== undefined) {
      const statuses = {
        401: { _tag: "CustomerOwnProfileAuthenticationProblem", code: "authentication_failed" },
        403: { _tag: "CustomerOwnProfileForbiddenProblem", code: "profile_forbidden" },
        409: { _tag: "CustomerOwnProfileConflictProblem", code: "profile_conflict" },
        503: {
          _tag: "CustomerOwnProfileUnavailableProblem",
          code: "profile_unavailable",
          retryable: true,
        },
      };
      return Response.json(
        {
          ...statuses[options.profileStatus],
          detail: "Profile could not be read or updated.",
          status: options.profileStatus,
          title: "Profile problem",
          type: "urn:test:profile",
        },
        { headers: { "content-type": "application/problem+json" }, status: options.profileStatus },
      );
    }
    if (request.method === "POST") {
      const payload = await request.json();
      return Response.json({
        ...payload,
        version: options.invalidUpdateReply === true ? "not-a-version" : "b".repeat(64),
      });
    }
    return Response.json(profile);
  };
  return { calls, fetch };
};

describe("native own customer profile", () => {
  it.effect("uses fresh admission and assertions while keeping login identity separate", () =>
    Effect.gen(function* freshNativeProfile() {
      const owner = backend();
      const context = portalRequestContext(
        origin,
        "staff.session=do-not-forward; commerce-portal.session_token=initial-session",
      );
      const result = yield* readCustomerProfileWithConfiguration(config, context).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toEqual({ profile, state: "ready", viewerEmail: "login@example.test" });
      const accountRead = owner.calls.find((request) =>
        new URL(request.url).pathname.endsWith("/customer-account"),
      );
      const profileRead = owner.calls.find((request) =>
        new URL(request.url).pathname.endsWith("/customer-profile"),
      );
      expect(accountRead?.headers.get("cookie")).toBe(
        "commerce-portal.session_token=initial-session",
      );
      expect(profileRead?.headers.get("cookie")).toBe(
        "commerce-portal.session_token=rotated-session",
      );
      expect(accountRead?.headers.get("authorization")).toBe("Bearer profile-assertion-1");
      expect(profileRead?.headers.get("authorization")).toBe("Bearer profile-assertion-2");
      expect(profileRead?.headers.get("origin")).toBe(origin);
      expect(profileRead?.headers.get("x-api-key")).toBeNull();
      expect(JSON.stringify(result)).not.toContain("provider-subject");
      expect(result.state === "ready" ? result.profile.contactEmail : null).toBe(
        "contact@example.test",
      );
      expect(context.setCookies).toHaveLength(1);
    }),
  );
  it.effect("keeps native provider and Party identities server-side for subsequent own reads", () =>
    Effect.gen(function* ownServerIdentity() {
      const owner = backend();
      const identity = yield* readPortalIdentityWithConfiguration(
        config,
        portalRequestContext(origin, "commerce-portal.session_token=initial-session"),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(identity).toMatchObject({
        account: {
          id: "provider-subject-1",
          partyId: "71000000-0000-4000-8000-000000000096",
          tenantId: config.tenantId,
        },
        state: "admitted",
      });
      expect(owner.calls).toHaveLength(2);
    }),
  );
  it.effect("returns anonymous without requesting private profile data", () =>
    Effect.gen(function* anonymousProfile() {
      const owner = backend({ anonymous: true });
      const result = yield* readCustomerProfileWithConfiguration(
        config,
        portalRequestContext(origin, ""),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toEqual({ state: "anonymous" });
      expect(owner.calls).toHaveLength(2);
    }),
  );
  it.effect("rejects an admitted account from a different tenant before profile access", () =>
    Effect.gen(function* wrongTenant() {
      const owner = backend({ foreignTenant: true });
      const result = yield* readCustomerProfileWithConfiguration(
        config,
        portalRequestContext(origin, "commerce-portal.session_token=initial-session"),
      ).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe("unavailable");
      }
      expect(owner.calls).toHaveLength(2);
    }),
  );
  it.effect(
    "passes the exact native CAS version and returns only owner-confirmed profile fields",
    () =>
      Effect.gen(function* ownProfileUpdate() {
        const owner = backend();
        const result = yield* updateCustomerProfileWithConfiguration(
          config,
          changed,
          portalRequestContext(origin, "commerce-portal.session_token=initial-session"),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(result).toEqual({
          profile: { ...changed, version: "b".repeat(64) },
          state: "ready",
        });
        const posts = owner.calls.filter(
          (request) =>
            new URL(request.url).pathname.endsWith("/customer-profile") &&
            request.method === "POST",
        );
        expect(posts).toHaveLength(1);
        expect(yield* Effect.promise(async () => await posts[0]?.json())).toEqual(changed);
        expect(posts[0]?.headers.get("authorization")).toBe("Bearer profile-assertion-2");
      }),
  );
  it.effect("does not overwrite a concurrent edit or automatically retry a conflict", () =>
    Effect.gen(function* profileCasConflict() {
      const owner = backend({ profileStatus: 409 });
      const result = yield* updateCustomerProfileWithConfiguration(
        config,
        changed,
        portalRequestContext(origin, "commerce-portal.session_token=initial-session"),
      ).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe("conflict");
      }
      expect(
        owner.calls.filter((request) =>
          new URL(request.url).pathname.endsWith("/customer-profile"),
        ),
      ).toHaveLength(1);
    }),
  );
  for (const options of [
    { profileStatus: 503 } satisfies BackendOptions,
    { invalidUpdateReply: true },
  ]) {
    it.effect(`keeps an unconfirmed write after ${JSON.stringify(options)}`, () =>
      Effect.gen(function* uncertainProfileWrite() {
        const owner = backend(options);
        const result = yield* updateCustomerProfileWithConfiguration(
          config,
          changed,
          portalRequestContext(origin, "commerce-portal.session_token=initial-session"),
        ).pipe(
          Effect.result,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe("unconfirmed");
        }
        expect(
          owner.calls.filter((request) =>
            new URL(request.url).pathname.endsWith("/customer-profile"),
          ),
        ).toHaveLength(1);
      }),
    );
  }
  for (const profileStatus of [401, 403] satisfies readonly BackendOptions["profileStatus"][]) {
    it.effect(`preserves profile authorization state ${profileStatus}`, () =>
      Effect.gen(function* ownerAuthorization() {
        const owner = backend({ profileStatus });
        const result = yield* readCustomerProfileWithConfiguration(
          config,
          portalRequestContext(origin, "commerce-portal.session_token=initial-session"),
        ).pipe(
          Effect.result,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe(profileStatus === 401 ? "anonymous" : "forbidden");
        }
      }),
    );
  }
});
