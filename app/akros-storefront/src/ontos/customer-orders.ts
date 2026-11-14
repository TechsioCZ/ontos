import "server-only";
import { readRecords } from "./gateway";
import type { CustomerAccount } from "./account";
import { orderStatusLabels, type CustomerOrder } from "./order-model";

/** Identity is obtained from the admitted portal session by the caller, never request search/body. */
export async function readCustomerOrders(account: CustomerAccount, orderId?: string, offset = 0) {
  const body = (await readRecords("merchandise", "records", {
    view: {
      storefront: true,
      storefrontCustomerOrders: {
        customerAccountId: account.id,
        ...(orderId ? { orderId } : {}),
        offset,
      },
    },
  })) as { orders?: CustomerOrder[]; totalOrders?: number };
  if (!Array.isArray(body.orders) || !Number.isSafeInteger(body.totalOrders))
    throw new Error("OntOS customer order response is malformed");
  for (const order of body.orders) {
    if (
      order.customerAccountId !== account.id ||
      !order.id ||
      !order.number ||
      !Object.hasOwn(orderStatusLabels, order.status) ||
      !Array.isArray(order.lines) ||
      !Number.isSafeInteger(order.totalMinor) ||
      !Number.isFinite(Date.parse(order.createdAt))
    )
      throw new Error("OntOS customer order response is malformed");
  }
  return { orders: body.orders, total: body.totalOrders! };
}
