import "server-only";
import { guard, jsonBody, problem, requestDictionary } from "@/ontos/http";
import { parseOrderStatusRequest, readOrderStatus } from "@/ontos/order-status";

const noStore = { "cache-control": "no-store" };
export async function POST(request: Request) {
  const t = requestDictionary(request);
  try {
    guard(request, t);
    const parsed = parseOrderStatusRequest(await jsonBody(request, t));
    if (!parsed)
      return Response.json(
        { message: t.server.orderStatus.invalid },
        { status: 400, headers: noStore },
      );
    const status = await readOrderStatus(parsed);
    if (!status)
      return Response.json(
        { message: t.server.orderStatus.notYet },
        { status: 404, headers: noStore },
      );
    return Response.json(status, { headers: noStore });
  } catch (e) {
    return problem(e, t.server.outage.orderStatus);
  }
}
