import { Effect, Result, Schema } from "effect";
import { CustomerOwnAddressBookSchema } from "@app/commerce-customer-context/api";
import { expect } from "@rstest/core";
import { it } from "effect-rstest";
import { FetchHttpClient } from "effect/http";
import {
  projectCustomerAddresses,
  readCustomerAddressesWithConfiguration,
} from "../src/ontos/customer-addresses-server";
import { portalRequestContext } from "../src/ontos/portal-server";
import type { StorefrontConfiguration } from "../src/ontos/config";
import { CustomerProfileFailure } from "../src/ontos/customer-profile-server";

const tenantId = "71000000-0000-4000-8000-000000000098";
const partyId = "71000000-0000-4000-8000-000000000096";
const profile = {
  kind: "RETAIL",
  profileRef: {
    moduleId: "commerce.customer-context",
    resourceId: "native-profile-not-account",
    resourceType: "commerce.customer-context.retail-customer-profile",
    tenantId,
  },
};
const savedAddressRef = {
  moduleId: "commerce.customer-context",
  resourceId: "address-a",
  resourceType: "commerce.customer-context.saved-address",
  tenantId,
};
const postalAddress = {
  addressLine1: "Ulice 1",
  addressLine2: "Patro 2",
  city: "Praha",
  countryCode: "CZ",
  postalCode: "11000",
  region: "Praha",
};
const address = {
  label: "Domů",
  lifecycle: "ACTIVE",
  origin: { kind: "COMMERCE_ONLY", postalAddress },
  profile,
  purposes: ["BILLING", "DELIVERY"],
  revision: 1,
  savedAddressRef,
};
const native = {
  addresses: [address],
  defaults: { billing: savedAddressRef, delivery: savedAddressRef, profile, revision: 1 },
};
const viewer = { partyId, tenantId, viewerEmail: "owner@example.test" };

it.effect(
  "preserves all native postal fields and defaults, without manufacturing a recipient or exposing identity references",
  () =>
    Effect.gen(function* postalProjection() {
      const decoded = yield* Schema.decodeUnknownEffect(CustomerOwnAddressBookSchema)(native);
      const result = yield* projectCustomerAddresses(decoded, viewer);
      expect(result).toEqual({
        addresses: [
          {
            id: "address-a",
            isBillingDefault: true,
            isDeliveryDefault: true,
            label: "Domů",
            location: { address: postalAddress, state: "available" },
            purposes: ["BILLING", "DELIVERY"],
          },
        ],
        state: "ready",
        viewerEmail: viewer.viewerEmail,
      });
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        "profileRef",
        "partyRef",
        "tenantId",
        "recipient",
        "firstName",
        "native-profile-not-account",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }),
);

it.effect(
  "represents Party-backed references as unresolved without fabricating a postal address",
  () =>
    Effect.gen(function* partyProjection() {
      const decoded = yield* Schema.decodeUnknownEffect(CustomerOwnAddressBookSchema)({
        ...native,
        addresses: [
          {
            ...address,
            origin: {
              contactPointRef: {
                moduleId: "party.registry",
                resourceId: "71000000-0000-4000-8000-000000000095",
                resourceType: "party.registry.party-contact-point",
                tenantId,
              },
              kind: "PARTY_BACKED",
              partyRef: {
                moduleId: "party.registry",
                resourceId: partyId,
                resourceType: "party.registry.party",
                tenantId,
              },
              sourceRevision: 1,
            },
          },
        ],
      });
      const result = yield* projectCustomerAddresses(decoded, viewer);
      expect(result).toMatchObject({
        addresses: [{ location: { state: "unresolved" } }],
        state: "ready",
      });
      expect(JSON.stringify(result)).not.toContain("71000000-0000-4000-8000-000000000095");
      expect(JSON.stringify(result)).not.toContain("partyRef");
    }),
);

it.effect("distinguishes a real empty address book from malformed or foreign-tenant data", () =>
  Effect.gen(function* emptyAndFailure() {
    const empty = yield* Schema.decodeUnknownEffect(CustomerOwnAddressBookSchema)({
      addresses: [],
      defaults: { profile, revision: 0 },
    });
    expect(yield* projectCustomerAddresses(empty, viewer)).toEqual({
      addresses: [],
      state: "ready",
      viewerEmail: viewer.viewerEmail,
    });
    for (const invalid of [
      {},
      { ...native, defaults: {} },
      {
        ...native,
        addresses: [
          {
            ...address,
            profile: {
              ...profile,
              profileRef: { ...profile.profileRef, resourceId: "same-tenant-foreign-profile" },
            },
          },
        ],
      },
      {
        ...native,
        defaults: {
          ...native.defaults,
          delivery: { ...savedAddressRef, resourceId: "foreign-address" },
        },
      },
      native,
    ]) {
      const target = invalid === native ? { ...viewer, tenantId: partyId } : viewer;
      const result = yield* Effect.result(
        Schema.decodeUnknownEffect(CustomerOwnAddressBookSchema)(invalid).pipe(
          Effect.mapError(() => new CustomerProfileFailure({ state: "unavailable" })),
          Effect.flatMap((decoded) => projectCustomerAddresses(decoded, target)),
        ),
      );
      expect(Result.isFailure(result) && result.failure.state).toBe("unavailable");
    }
  }),
);

const config = {
  apiKey: "test-only-address-service-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId,
} satisfies StorefrontConfiguration;

const backend = (mode: "ready" | "changed" | "anonymous" | "refused" | "malformed") => {
  const calls: Request[] = [];
  let accounts = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("/gateway-context")) {
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/commerce-customer-context",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: `address-assertion-${calls.length}`,
      });
    }
    if (path.endsWith("/customer-account")) {
      accounts += 1;
      return Response.json(
        mode === "anonymous"
          ? { state: "anonymous" }
          : {
              account: {
                email: viewer.viewerEmail,
                id:
                  mode === "changed" && accounts === 2 ? "different-provider" : "original-provider",
                name: "Not an address recipient",
                partyId,
                tenantId,
              },
              state: "authenticated",
            },
      );
    }
    if (path.endsWith("/customer-address-book")) {
      if (mode === "malformed") {
        return Response.json({});
      }
      return mode === "refused"
        ? Response.json(
            {
              _tag: "CommercePortalAuthSessionForbiddenProblem",
              code: "account_disabled",
              detail: "Refused",
              status: 403,
              title: "Refused",
              type: "urn:test:refused",
            },
            { headers: { "content-type": "application/problem+json" }, status: 403 },
          )
        : Response.json(native);
    }
    return Response.json({}, { status: 503 });
  };
  return { calls, fetch };
};

it.effect(
  "uses native generated address reads, fresh admission and Portal-only cookies without sending a subject",
  () =>
    Effect.gen(function* ownNativeRead() {
      const owner = backend("ready");
      const request = portalRequestContext(
        "https://n1.example",
        "staff.session=omit; commerce-portal.session_token=session",
      );
      const result = yield* readCustomerAddressesWithConfiguration(config, request).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({ state: "ready", viewerEmail: viewer.viewerEmail });
      const reads = owner.calls.filter(
        (call) => !new URL(call.url).pathname.endsWith("/gateway-context"),
      );
      expect(reads.map((call) => new URL(call.url).pathname.split("/").at(-1))).toEqual([
        "customer-account",
        "customer-address-book",
        "customer-account",
      ]);
      for (const read of reads) {
        expect(read.method).toBe("GET");
        expect(read.headers.get("cookie")).toBe("commerce-portal.session_token=session");
        expect(read.headers.get("x-api-key")).toBeNull();
        expect(new URL(read.url).search).toBe("");
      }
      expect(new Set(reads.map((read) => read.headers.get("authorization"))).size).toBe(3);
      expect(JSON.stringify(result)).not.toContain("Not an address recipient");
    }),
);

for (const mode of ["changed", "refused", "malformed"] as const) {
  it.effect(`does not release an address response when session is ${mode}`, () =>
    Effect.gen(function* changedViewer() {
      const owner = backend(mode);
      const result = yield* Effect.result(
        readCustomerAddressesWithConfiguration(
          config,
          portalRequestContext("https://n1.example", "commerce-portal.session_token=session"),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        ),
      );
      expect(Result.isFailure(result) && result.failure.state).toBe(
        mode === "refused" ? "forbidden" : "unavailable",
      );
      expect(JSON.stringify(result)).not.toContain("Ulice 1");
    }),
  );
}

it.effect("does not request an address book for an anonymous viewer", () =>
  Effect.gen(function* anonymousViewer() {
    const owner = backend("anonymous");
    const result = yield* readCustomerAddressesWithConfiguration(
      config,
      portalRequestContext("https://n1.example", ""),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
    );
    expect(result).toEqual({ state: "anonymous" });
    expect(
      owner.calls.some((call) => new URL(call.url).pathname.endsWith("/customer-address-book")),
    ).toBe(false);
  }),
);
