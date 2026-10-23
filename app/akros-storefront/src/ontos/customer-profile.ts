import "server-only";
import { headers } from "next/headers";
import { portalRequest } from "./account";
import { OntosError } from "./gateway";
import { isCustomerProfile } from "./profile-model";
import type { CustomerProfile } from "./profile-model";

/** The commerce owner alone resolves the admitted session's Party and invokes Party Registry. */
async function profileResponse(response: Response) {
  if (!response.ok) {
    throw new OntosError("Customer profile owner refused the request", response.status);
  }
  const value: unknown = await response.json();
  if (!isCustomerProfile(value)) {
    throw new Error("Customer profile response is malformed");
  }
  return value;
}

export async function readCustomerProfile(origin?: string, cookie?: string | null) {
  if (origin === undefined) {
    const requestHeaders = await headers();
    const host = requestHeaders.get("host");
    if (!host) {
      throw new Error("Storefront request host is missing");
    }
    const protocol =
      host.startsWith("localhost:") || host.startsWith("127.0.0.1:") ? "http" : "https";
    origin = `${protocol}://${host}`;
    cookie = requestHeaders.get("cookie");
  }
  return {
    profile: await profileResponse(
      await portalRequest("/customer-profile", origin, cookie ?? null),
    ),
  };
}

export async function saveCustomerProfile(
  origin: string,
  cookie: string | null,
  input: CustomerProfile,
) {
  return await profileResponse(await portalRequest("/customer-profile", origin, cookie, input));
}
