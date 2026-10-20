import "server-only";
import { isOntos } from "@/ontos/config";

const events = ["ORDER_CREATED", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];
const statuses = ["SENDING", "SENT", "RETRY", "FAILED", "UNKNOWN"];
const dispatcherUrl = () =>
  (process.env.EMAIL_DISPATCHER_URL ?? "http://127.0.0.1:3096").replace(/\/+$/, "");
type Receipt = { event: string; status: string; sentAt: string | null };
function toReceipt(value: unknown): Receipt | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.event !== "string" || !events.includes(v.event)) return null;
  if (typeof v.status !== "string" || !statuses.includes(v.status)) return null;
  return {
    event: v.event,
    status: v.status,
    sentAt: typeof v.sentAt === "string" ? v.sentAt : null,
  };
}
export async function GET(request: Request) {
  if (!isOntos())
    return Response.json({ message: "Připojení k OntOS není zapnuté." }, { status: 404 });
  const orderNumber = new URL(request.url).searchParams.get("orderNumber") ?? "";
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(orderNumber))
    return Response.json({ message: "Neplatné číslo objednávky." }, { status: 400 });
  try {
    const params = new URLSearchParams({ source: "akros-order", subjectNumber: orderNumber });
    const upstream = await fetch(`${dispatcherUrl()}/v1/deliveries?${params.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!upstream.ok) throw new Error(`dispatcher HTTP ${upstream.status}`);
    const body = (await upstream.json()) as { deliveries?: unknown };
    const deliveries = Array.isArray(body.deliveries)
      ? body.deliveries.map(toReceipt).filter((r): r is Receipt => r !== null)
      : [];
    return Response.json({ deliveries }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[AKROS] order e-mail status", error instanceof Error ? error.message : "failed");
    return Response.json({ message: "Stav e-mailů se nepodařilo ověřit." }, { status: 503 });
  }
}
