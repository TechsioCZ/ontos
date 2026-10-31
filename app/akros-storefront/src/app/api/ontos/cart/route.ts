import "server-only";
import { guard, jsonBody, problem } from "@/ontos/http";
import { assertCart, quoteCart } from "@/ontos/quote";
export async function POST(request: Request) {
  try {
    guard(request);
    const { cart, deliveryId } = await jsonBody(request);
    assertCart(cart);
    return Response.json(await quoteCart(cart, deliveryId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return problem(e);
  }
}
