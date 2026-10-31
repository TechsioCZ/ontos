import "server-only";
import { guard, jsonBody, outageMessage, problem } from "@/ontos/http";
import { parseOrderStatusRequest, readOrderStatus } from "@/ontos/order-status";

const noStore = { "cache-control": "no-store" };
export async function POST(request: Request) {
  try {
    guard(request);
    const parsed = parseOrderStatusRequest(await jsonBody(request));
    if (!parsed)
      return Response.json(
        { message: "Neplatný dotaz na stav objednávky." },
        { status: 400, headers: noStore },
      );
    const status = await readOrderStatus(parsed);
    if (!status)
      return Response.json(
        { message: "Stav objednávky zatím není k dispozici." },
        { status: 404, headers: noStore },
      );
    return Response.json(status, { headers: noStore });
  } catch (e) {
    return problem(e, outageMessage.orderStatus);
  }
}
