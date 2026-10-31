import { readCheckoutOptions } from "@/ontos/checkout-options";
import { problem } from "@/ontos/http";
export async function GET() {
  try {
    return Response.json(await readCheckoutOptions(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problem(error, "Možnosti dopravy se nepodařilo načíst z OntOS.");
  }
}
