import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import "server-only";
import { guard, jsonBody, problem, requestDictionary } from "@/ontos/http";
import { assertCart, quoteCart } from "@/ontos/quote";
export async function POST(request: Request) {
  const t = requestDictionary(request);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    guard(request, t);
    const { cart, deliveryId } = await jsonBody(request, t, lifetime);
    assertCart(cart, t);
    return Response.json(await quoteCart(cart, deliveryId, t, { operation: lifetime }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return problem(e, t.server.outage.cart);
  } finally {
    lifetime.dispose();
  }
}
