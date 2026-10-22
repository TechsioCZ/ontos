import "server-only";
import { warmCatalog } from "@/ontos/catalog-server";

/**
 * Reads what first views need (navigation tree, homepage selection, every sidebar category with its first
 * listing page) into the shared catalog cache: called by the scheduled trigger and after a deploy. Values
 * younger than this are skipped, so repeated calls within the window cost no OntOS reads.
 */
const WARM_MIN_AGE_MS = 12 * 60_000;

export async function POST() {
  const counts = await warmCatalog(WARM_MIN_AGE_MS);
  return Response.json(counts, {
    status: counts.failed > 0 ? 503 : 200,
    headers: { "cache-control": "no-store" },
  });
}
