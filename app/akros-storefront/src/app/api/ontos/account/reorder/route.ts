import "server-only";
import { readAccount } from "@/ontos/account";
import { readCartProducts } from "@/ontos/catalog-server";
import { readCustomerOrders } from "@/ontos/customer-orders";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";
import { resolveReorder } from "@/ontos/reorder";

const noStore = { "cache-control": "no-store" };

/**
 * Repeat order: the saved order is read for the admitted portal session only (the browser sends just the
 * order id), its lines are resolved against the current catalogue of the active market. Nothing is stored;
 * the browser adds the returned lines to its active cart and the cart quote re-checks them in OntOS.
 */
export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const origin = requestOrigin(request);
    if (request.headers.get("origin") !== origin)
      throw new RequestError(403, t.server.request.foreignOrigin);
    const input: unknown = await jsonBody(request, t);
    const orderId =
      input && typeof input === "object" && "orderId" in input ? input.orderId : undefined;
    if (typeof orderId !== "string" || !orderId || orderId.length > 200)
      throw new RequestError(400, t.server.reorder.missingOrder);
    const account = await readAccount(origin, request.headers.get("cookie"));
    if (!account)
      return Response.json({ message: t.server.reorder.signIn }, { status: 401, headers: noStore });
    const order = (await readCustomerOrders(account, orderId)).orders.find(
      (entry) => entry.id === orderId,
    );
    if (!order) throw new RequestError(404, t.server.reorder.notFound);
    const lines = order.lines.filter(
      (line) => typeof line.productId === "string" && line.productId,
    );
    const resolution = lines.length
      ? resolveReorder({ lines }, await readCartProducts(lines))
      : { items: [], skipped: [] };
    return Response.json(resolution, { headers: noStore });
  } catch (error) {
    return problem(error, t.server.reorder.unavailable);
  }
}
