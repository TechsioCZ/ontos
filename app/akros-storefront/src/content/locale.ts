import "server-only";
import { brandLocale } from "@/brand";
import { getMarketResolution } from "@/ontos/active-market";

/** The brand language of this request (`cs`, `sk`, `en`; other markets read English). Never throws, so metadata stays safe. */
export async function contentLocale() {
  const resolution = await getMarketResolution();
  return brandLocale(resolution.kind === "live" ? resolution.market.locale : resolution.locale);
}
