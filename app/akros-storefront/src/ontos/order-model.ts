export const orderStatusLabels = {
  NEW: "Nová",
  CONFIRMED: "Zpracovává se",
  PACKING: "Připravená k předání",
  SHIPPED: "Předáno dopravci",
  DELIVERED: "Dokončená",
  CANCELLED: "Stornovaná",
} as const;
export type OntosOrderStatus = keyof typeof orderStatusLabels;

/** Historical amounts are the saved order receipt, not a quote for a new purchase. */
export interface CustomerOrder {
  id: string;
  customerAccountId: string;
  number: string;
  status: OntosOrderStatus;
  createdAt: string;
  updatedAt: string;
  totalMinor: number;
  totalVatMinor: number;
  pricesIncludeVat?: boolean;
  contact?: { name: string; email: string; phone?: string };
  deliveryAddress?: { street: string; city: string; postalCode: string; country?: string };
  shipping?: { label: string; method: string; priceMinor: number; vatRate: number };
  lines: {
    productId: string;
    productName: string;
    sku: string;
    quantity: number;
    unitPriceMinor: number;
    vatRate: number;
    variantId?: string;
    variantName?: string;
  }[];
  history?: { kind: string; at: string; before?: string; after?: string; reason?: string }[];
}

export const orderHref = (order: Pick<CustomerOrder, "id">) =>
  `/detail-objednavky?order=${encodeURIComponent(order.id)}`;
