import "server-only";
import { guard, jsonBody, problem, requestDictionary } from "@/ontos/http";
import { assertCart, quoteCart } from "@/ontos/quote";
export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const { cart, deliveryId } = await jsonBody(request, t);
    assertCart(cart, t);
    return Response.json(await quoteCart(cart, deliveryId, t), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return problem(e, t.server.outage.cart);
  }
}
