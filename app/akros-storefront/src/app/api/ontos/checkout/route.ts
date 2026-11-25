import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import { readCheckoutOptions } from "@/ontos/checkout-options";
import { problem, requestDictionary } from "@/ontos/http";
export async function GET(request: Request) {
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    return Response.json(await readCheckoutOptions({ operation: lifetime }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return problem(error, requestDictionary(request).server.outage.shipping);
  } finally {
    lifetime.dispose();
  }
}
