"use client";

import { Effect, Match } from "effect";
import { HttpApiClient } from "effect/http-api";
import { CustomerProfileApi } from "./customer-profile";
import type { CustomerAddressesRead } from "./customer-addresses";
import type { PortalOutcome } from "./portal";

export type CustomerAddressIdentity = Extract<PortalOutcome, { state: "admitted" }>;
export type CustomerAddressesView = CustomerAddressesRead | { state: "forbidden" | "unavailable" };
export interface CustomerAddressesSnapshot {
  readonly identity: CustomerAddressIdentity;
  readonly result: CustomerAddressesView;
}
const client = HttpApiClient.make(CustomerProfileApi);
export const readCustomerAddresses = () =>
  client.pipe(
    Effect.flatMap((api) => api.customerProfile.readAddresses()),
    Effect.timeout("65 seconds"),
    Effect.match({
      onFailure: (error): CustomerAddressesView =>
        Match.value(error).pipe(
          Match.tag("CustomerProfileAuthenticationProblem", () => ({
            state: "anonymous" as const,
          })),
          Match.tag("CustomerProfileForbiddenProblem", () => ({ state: "forbidden" as const })),
          Match.orElse(() => ({ state: "unavailable" as const })),
        ),
      onSuccess: (result): CustomerAddressesView => result,
    }),
  );

/** An exact auth-instance token fences a late result even when a later login uses the same email. */
export const customerAddressesForIdentity = (
  snapshot: CustomerAddressesSnapshot | null,
  identity: CustomerAddressIdentity,
): CustomerAddressesView | { state: "loading" } => {
  if (snapshot?.identity !== identity) {
    return { state: "loading" };
  }
  return snapshot.result.state === "ready" && snapshot.result.viewerEmail !== identity.email
    ? { state: "unavailable" }
    : snapshot.result;
};
