import "server-only";
import { warmCatalog } from "@/ontos/catalog-server";

/**
 * Warms only the price-free navigation tree, on the scheduled trigger and after a deploy.
 * Product prices and stock are read on demand, never warmed for a 15-minute schedule.
 * Repeated calls within this window cost no OntOS reads.
 */
const WARM_MIN_AGE_MS = 12 * 60_000;

export async function POST() {
  const counts = await warmCatalog(WARM_MIN_AGE_MS);
  return Response.json(counts, {
    status: counts.failed > 0 ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
