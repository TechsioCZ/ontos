import "server-only";
import { readRecords } from "./gateway";

import { orderStatusLabels, type OntosOrderStatus } from "./order-model";
export { orderStatusLabels, type OntosOrderStatus } from "./order-model";
export interface OrderStatusRequest {
  orderId: string;
  clientRequestId: string;
}
export interface LiveOrderStatus {
  id: string;
  number: string;
  status: OntosOrderStatus;
  statusLabel: string;
  updatedAt: string;
  /** DELIVERED or CANCELLED: the browser stops polling. */
  final: boolean;
}

const isStatus = (value: unknown): value is OntosOrderStatus =>
  typeof value === "string" && Object.hasOwn(orderStatusLabels, value);

export function parseOrderStatusRequest(value: unknown): OrderStatusRequest | null {
  if (!value || typeof value !== "object") return null;
  const { orderId, clientRequestId } = value as Record<string, unknown>;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9-]{8,120}$/.test(orderId)) return null;
  if (typeof clientRequestId !== "string" || !/^akros-[a-f0-9-]{36}$/.test(clientRequestId))
    return null;
  return { orderId, clientRequestId };
}

/** Owner read `view.storefrontOrderStatus` (no PII). Null when OntOS does not know this pair. */
export async function readOrderStatus(
  request: OrderStatusRequest,
): Promise<LiveOrderStatus | null> {
  const body = (await readRecords("merchandise", "records", {
    view: { storefront: true, storefrontOrderStatus: request },
  })) as { orderStatus?: unknown };
  const value = body.orderStatus;
  if (!value || typeof value !== "object") return null;
  const { id, number, status, updatedAt } = value as Record<string, unknown>;
  if (
    id !== request.orderId ||
    typeof number !== "string" ||
    !isStatus(status) ||
    typeof updatedAt !== "string"
  )
    return null;
  return {
    id: request.orderId,
    number,
    status,
    statusLabel: orderStatusLabels[status],
    updatedAt,
    final: status === "DELIVERED" || status === "CANCELLED",
  };
}
