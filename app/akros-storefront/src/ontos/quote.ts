import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { RequestError } from "./http";
import { purchaseConstraints } from "./purchase-constraints";
import type { CartState, CartLine } from "@/features/cart/cart-state";
import { createCatalog } from "./catalog-model";
import { readCartProducts } from "./catalog-server";
import { callAction } from "./gateway";
export function assertCart(value: unknown): asserts value is CartState {
  const cart = value as CartState;
  if (
    cart?.version !== 3 ||
    !Array.isArray(cart.lines) ||
    cart.lines.length < 1 ||
    cart.lines.length > 50
  )
    throw new RequestError(400, "Neplatný košík.");
  const seen = new Set<string>();
  for (const l of cart.lines) {
    const key = `${l.productId}:${l.variantId ?? ""}`;
    if (
      seen.has(key) ||
      typeof l.productId !== "string" ||
      (l.variantId !== undefined && typeof l.variantId !== "string") ||
      !Number.isFinite(l.quantity) ||
      l.quantity <= 0 ||
      l.quantity > 1_000_000_000 ||
      !Number.isSafeInteger(l.priceMinor) ||
      l.priceMinor < 0
    )
      throw new RequestError(400, "Neplatná položka košíku.");
    seen.add(key);
  }
}

/** Why one cart line cannot continue. `code` mirrors the owner's storefront issue codes where one exists. */
export interface QuoteLineIssue {
  productId: string;
  variantId?: string;
  code:
    | "NOT_AVAILABLE"
    | "AVAILABILITY_UNKNOWN"
    | "PRICE_UNAVAILABLE"
    | "OUT_OF_STOCK"
    | "INSUFFICIENT_STOCK"
    | "MINIMUM_QUANTITY"
    | "PACKAGE_QUANTITY"
    | "OWNER_REJECTED";
  message: string;
}

/** Totals computed by OntOS itself (PlaceStorefrontOrder dry run): the browser never recomputes VAT. */
export interface QuoteTotals {
  totalMinor: number;
  totalVatMinor: number;
  netMinor: number;
  /** null = no supported shipping method chosen yet, so the totals cover goods only. */
  shippingMinor: number | null;
}

export interface CartQuote {
  cart: CartState;
  priceChanged: boolean;
  issues: string[];
  lineIssues: QuoteLineIssue[];
  canCheckout: boolean;
  totals: QuoteTotals | null;
}

const ownerShippingMethod = (deliveryId: unknown) =>
  deliveryId === "PPL" || deliveryId === "CESKA_POSTA" ? deliveryId : undefined;

const ownerCodes = new Set<QuoteLineIssue["code"]>([
  "NOT_AVAILABLE",
  "AVAILABILITY_UNKNOWN",
  "PRICE_UNAVAILABLE",
  "OUT_OF_STOCK",
  "INSUFFICIENT_STOCK",
  "MINIMUM_QUANTITY",
  "PACKAGE_QUANTITY",
]);

interface OwnerDryRun {
  storefrontOrder?: {
    outcome?: string;
    totalMinor?: number;
    totalVatMinor?: number;
    shippingPriceMinor?: number;
    issues?: { code?: string; message?: string; productId?: string; variantId?: string }[];
  };
}

/**
 * Asks OntOS to validate the exact cart without saving (PlaceStorefrontOrder dryRun): the owner checks
 * availability, quantities and prices and returns its own totals incl. VAT. Nothing is stored.
 */
async function ownerDryRun(cart: CartState, revision: number, deliveryId: unknown) {
  const method = ownerShippingMethod(deliveryId);
  const lines = cart.lines.map((l) => ({
    productId: l.productId,
    ...(l.variantId ? { variantId: l.variantId } : {}),
    quantity: l.quantity,
    expectedUnitPriceMinor: l.priceMinor,
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify({ lines, method, revision }))
    .digest("hex")
    .slice(0, 32);
  const command = {
    _tag: "PlaceStorefrontOrder",
    dryRun: true,
    clientRequestId: `akros-quote-${digest}`,
    shippingMethod: method ?? "OSOBNI_ODBER",
    lines,
  };
  const result = (await callAction(
    "merchandise",
    "apply-command",
    { command, expectedRevision: revision },
    // A dry run saves nothing, and OntOS refuses a reused key (409 action_already_committed): fresh key per check.
    `akros-quote-${randomUUID()}`,
  )) as OwnerDryRun;
  const order = result.storefrontOrder;
  if (!order || !["VALID", "REJECTED"].includes(order.outcome ?? ""))
    throw new Error("OntOS dry run returned no verdict");
  return { order, shippingIncluded: method !== undefined };
}

export async function quoteCart(cart: CartState, deliveryId?: unknown): Promise<CartQuote> {
  const snapshot = await readCartProducts(cart.lines);
  const model = createCatalog(snapshot, { categories: [] });
  const lineIssues: QuoteLineIssue[] = [];
  let priceChanged = false;
  const lines: CartLine[] = cart.lines.map((line) => {
    const ids = {
      productId: line.productId,
      ...(line.variantId ? { variantId: line.variantId } : {}),
    };
    const p = model.getProductById(line.productId);
    const v = p?.detail.variants.find((v) => v.id === line.variantId);
    const fallbackLabel = `${line.name || "Položka"}${line.variantLabel ? ` (${line.variantLabel})` : ""}`;
    // The read carries only the cart's variants, so a group is recognised by its variant summary.
    if (!p || (line.variantId ? !v : p.variantSummary.count > 0)) {
      lineIssues.push({
        ...ids,
        code: "NOT_AVAILABLE",
        message: `${fallbackLabel}: zboží již není v nabídce.`,
      });
      return line;
    }
    const label = v ? `${p.name} (${v.label})` : p.name;
    const item = v ?? p;
    if (item.priceUnavailableReason || item.priceMinor <= 0) {
      lineIssues.push({
        ...ids,
        code: "PRICE_UNAVAILABLE",
        message: `${label}: cena není dostupná. ${item.priceUnavailableReason ?? ""}`.trim(),
      });
      return line;
    }
    const tier = [...(v?.priceTiers ?? p.detail.priceTiers)]
      .filter((t) => t.minimumQuantity <= line.quantity)
      .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];
    const price = tier?.priceMinor ?? item.priceMinor;
    if (line.priceMinor !== price) priceChanged = true;
    if (item.availabilityUnknown)
      lineIssues.push({
        ...ids,
        code: "AVAILABILITY_UNKNOWN",
        message: `${label}: dostupnost nyní nelze ověřit, objednávku proto nelze dokončit. Položku odeberte nebo to zkuste později.`,
      });
    else if (item.stockCount <= 0)
      lineIssues.push({
        ...ids,
        code: "OUT_OF_STOCK",
        message: `${label}: momentálně není skladem.`,
      });
    else if (line.quantity > item.stockCount)
      lineIssues.push({
        ...ids,
        code: "INSUFFICIENT_STOCK",
        message: `${label}: k dispozici je jen ${item.stockCount.toLocaleString("cs-CZ")} ${item.unit}.`,
      });
    if (line.quantity < item.minimumQuantity)
      lineIssues.push({
        ...ids,
        code: "MINIMUM_QUANTITY",
        message: `${label}: minimální množství je ${item.minimumQuantity} ${item.unit}.`,
      });
    const step = item.packageQuantity;
    if (step && Math.abs(line.quantity / step - Math.round(line.quantity / step)) > 0.000001)
      lineIssues.push({
        ...ids,
        code: "PACKAGE_QUANTITY",
        message: `${label}: objednejte celé balení po ${step} ${item.unit}.`,
      });
    return {
      ...line,
      name: p.name,
      vatRate: p.vatRate,
      slug: p.slug,
      sku: item.sku,
      unit: item.unit,
      stockCount: item.stockCount,
      ...purchaseConstraints(item.minimumQuantity, item.packageQuantity),
      priceMinor: price,
      priceExcludingVatMinor: tier?.priceExcludingVatMinor,
    };
  });
  let totals: QuoteTotals | null = null;
  if (!priceChanged && !lineIssues.length) {
    // Same lines the order will send; OntOS has the final word on availability and totals.
    const { order, shippingIncluded } = await ownerDryRun(cart, snapshot.revision, deliveryId);
    for (const issue of order.issues ?? []) {
      if (typeof issue.message !== "string" || !issue.message || issue.message.length > 300)
        continue;
      const code = ownerCodes.has(issue.code as QuoteLineIssue["code"])
        ? (issue.code as QuoteLineIssue["code"])
        : "OWNER_REJECTED";
      if (issue.code === "PRICE_CHANGED") priceChanged = true;
      lineIssues.push({
        productId: issue.productId ?? "",
        ...(issue.variantId ? { variantId: issue.variantId } : {}),
        code,
        message: issue.message,
      });
    }
    if (
      order.outcome === "VALID" &&
      Number.isSafeInteger(order.totalMinor) &&
      Number.isSafeInteger(order.totalVatMinor)
    )
      totals = {
        totalMinor: order.totalMinor!,
        totalVatMinor: order.totalVatMinor!,
        netMinor: order.totalMinor! - order.totalVatMinor!,
        shippingMinor: shippingIncluded ? (order.shippingPriceMinor ?? 0) : null,
      };
  }
  const issues = lineIssues.map((issue) => issue.message);
  return {
    cart: { version: 3 as const, lines },
    priceChanged,
    issues,
    lineIssues,
    canCheckout: !priceChanged && !issues.length && totals !== null,
    totals,
  };
}
