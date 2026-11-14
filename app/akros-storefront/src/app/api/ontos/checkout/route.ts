import { readCheckoutOptions } from "@/ontos/checkout-options";
import { problem, requestDictionary } from "@/ontos/http";
export async function GET(request: Request) {
  try {
    return Response.json(await readCheckoutOptions(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return problem(error, requestDictionary(request).server.outage.shipping);
  }
}
