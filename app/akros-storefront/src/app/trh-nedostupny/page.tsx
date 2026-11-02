import { notFound } from "next/navigation";
import { getMarketResolution } from "@/ontos/active-market";

/**
 * Proxy rewrite target for a market that exists but is not active now (src/proxy.ts). It reads no catalog
 * data; the root layout renders „Tento trh je dočasně nedostupný“ with links to the live markets instead.
 */
export default async function MarketUnavailableRoute() {
  if ((await getMarketResolution()).kind !== "not-active") notFound();
  return null;
}
