import "server-only";
import { CustomerOwnAddressBookSchema } from "@app/commerce-customer-context/api";
import type { CustomerOwnAddressBook } from "@app/commerce-customer-context/api";
import { Effect, Match, Schema } from "effect";
import type { CustomerAddressViewer, CustomerAddressesRead } from "./customer-addresses";
import { CustomerProfileFailure } from "./customer-profile-server";
import { readConfiguration } from "./config";
import type { StorefrontConfiguration } from "./config";
import { readPortalOwnAddressBook, readPortalIdentityWithConfiguration } from "./portal-server";
import type { PortalRequestContext } from "./portal-server";

const unavailable = () => new CustomerProfileFailure({ state: "unavailable" });

/** Native refs remain server-side. Missing Party-backed postal projections stay explicitly unresolved. */
export const projectCustomerAddresses = Effect.fn("N1.projectCustomerAddresses")(function* project(
  input: CustomerOwnAddressBook,
  viewer: CustomerAddressViewer,
) {
  const native = yield* Schema.decodeUnknownEffect(CustomerOwnAddressBookSchema)(input).pipe(
    Effect.mapError(unavailable),
  );
  const { profile } = native.defaults;
  if (
    profile.kind !== "RETAIL" ||
    profile.profileRef.tenantId !== viewer.tenantId ||
    native.addresses.some(
      (address) =>
        address.profile.kind !== "RETAIL" ||
        address.profile.profileRef.tenantId !== viewer.tenantId ||
        address.profile.profileRef.resourceId !== profile.profileRef.resourceId ||
        (address.origin.kind === "PARTY_BACKED" &&
          address.origin.partyRef.resourceId !== viewer.partyId),
    )
  ) {
    return yield* Effect.fail(unavailable());
  }
  for (const purpose of ["billing", "delivery"] as const) {
    const ref = native.defaults[purpose];
    if (
      ref !== undefined &&
      native.addresses.filter(
        (address) =>
          address.savedAddressRef.resourceId === ref.resourceId &&
          address.savedAddressRef.tenantId === ref.tenantId &&
          address.purposes.includes(purpose === "billing" ? "BILLING" : "DELIVERY"),
      ).length !== 1
    ) {
      return yield* Effect.fail(unavailable());
    }
  }
  return {
    addresses: native.addresses.map((address) => ({
      id: address.savedAddressRef.resourceId,
      isBillingDefault: native.defaults.billing?.resourceId === address.savedAddressRef.resourceId,
      isDeliveryDefault:
        native.defaults.delivery?.resourceId === address.savedAddressRef.resourceId,
      label: address.label,
      location:
        address.origin.kind === "COMMERCE_ONLY" && address.origin.postalAddress !== undefined
          ? { address: address.origin.postalAddress, state: "available" as const }
          : { state: "unresolved" as const },
      purposes: address.purposes,
    })),
    state: "ready" as const,
    viewerEmail: viewer.viewerEmail,
  };
});

const readFailure = (error: Effect.Error<ReturnType<typeof readPortalOwnAddressBook>>) =>
  Match.value(error).pipe(
    Match.tag(
      "CommercePortalAuthSessionAuthenticationProblem",
      () => new CustomerProfileFailure({ state: "anonymous" }),
    ),
    Match.tag(
      "CommercePortalAuthSessionForbiddenProblem",
      () => new CustomerProfileFailure({ state: "forbidden" }),
    ),
    Match.tag(
      "PortalFailure",
      (failure) =>
        new CustomerProfileFailure({
          state: failure.reason === "refused" ? "forbidden" : "unavailable",
        }),
    ),
    Match.orElse(unavailable),
  );

export const readCustomerAddressesWithConfiguration = Effect.fn("N1.readCustomerAddresses")(
  function* readAddresses(config: StorefrontConfiguration, request: PortalRequestContext) {
    const identity = yield* readPortalIdentityWithConfiguration(config, request).pipe(
      Effect.mapError(readFailure),
    );
    if (identity.state === "anonymous") {
      return { state: "anonymous" as const };
    }
    const native = yield* readPortalOwnAddressBook(config, request).pipe(
      Effect.mapError(readFailure),
    );
    const current = yield* readPortalIdentityWithConfiguration(config, request).pipe(
      Effect.mapError(readFailure),
    );
    if (current.state === "anonymous") {
      return yield* Effect.fail(new CustomerProfileFailure({ state: "anonymous" }));
    }
    if (
      current.account.id !== identity.account.id ||
      current.account.partyId !== identity.account.partyId ||
      current.account.tenantId !== identity.account.tenantId ||
      current.account.email !== identity.account.email
    ) {
      return yield* Effect.fail(unavailable());
    }
    return yield* projectCustomerAddresses(native, {
      partyId: identity.account.partyId,
      tenantId: identity.account.tenantId,
      viewerEmail: identity.account.email,
    });
  },
);

export const readCustomerAddresses = (request: PortalRequestContext) =>
  readConfiguration(process.env).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((config) => readCustomerAddressesWithConfiguration(config, request)),
    Effect.map((result): CustomerAddressesRead => result),
  );
