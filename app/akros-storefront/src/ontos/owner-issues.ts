import type { Dictionary } from "@/i18n";
import { formatPrice, type MoneyFormat } from "@/lib/format";

/**
 * One issue of a merchandise `PlaceStorefrontOrder` verdict (dry run or real order). The owner writes `message` in
 * Czech; the storefront never shows it. It words the issue from the language-neutral `code` and the structured
 * fields in the request's market language instead.
 */
export interface OwnerIssue {
  code?: string;
  message?: string;
  productId?: string;
  variantId?: string;
  availableQuantity?: number;
  currentUnitPriceMinor?: number;
  expectedUnitPriceMinor?: number;
}

/** What the storefront knows about the cart line an issue names (cart line or fresh catalog item). */
export interface OwnerIssueLine {
  label: string;
  unit?: string;
  minimumQuantity?: number;
  packageQuantity?: number;
}

const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The issue in the market language; `line` is undefined when the issue names no known cart line. */
export function ownerIssueText(
  issue: OwnerIssue,
  line: OwnerIssueLine | undefined,
  t: Dictionary,
  money: MoneyFormat,
): string {
  const messages = t.server.cart;
  const label = line?.label || messages.fallbackItem;
  const unit = line?.unit ?? "";
  switch (issue.code) {
    case "NOT_FOUND":
    case "NOT_AVAILABLE":
    case "NOT_OFFERED_IN_MARKET":
      return messages.notAvailable(label);
    case "VARIANT_REQUIRED":
      return messages.variantRequired(label);
    case "OUT_OF_STOCK":
      return messages.outOfStock(label);
    case "INSUFFICIENT_STOCK":
      return typeof issue.availableQuantity === "number" &&
        Number.isFinite(issue.availableQuantity) &&
        issue.availableQuantity > 0
        ? messages.insufficientStock(label, issue.availableQuantity, unit)
        : issue.availableQuantity === 0
          ? messages.outOfStock(label)
          : messages.stockShort(label);
    case "AVAILABILITY_UNKNOWN":
      return messages.availabilityUnknown(label);
    case "MINIMUM_QUANTITY":
      return positive(line?.minimumQuantity)
        ? messages.minimumQuantity(label, line.minimumQuantity, unit)
        : messages.quantityRejected(label);
    case "PACKAGE_QUANTITY":
      return positive(line?.packageQuantity)
        ? messages.packageQuantity(label, line.packageQuantity, unit)
        : messages.quantityRejected(label);
    case "PRICE_UNAVAILABLE":
      return messages.priceUnavailable(label, "");
    case "PRICE_CHANGED":
      return amount(issue.expectedUnitPriceMinor) && amount(issue.currentUnitPriceMinor)
        ? messages.priceChanged(
            label,
            formatPrice(issue.expectedUnitPriceMinor, money),
            formatPrice(issue.currentUnitPriceMinor, money),
          )
        : messages.priceChangedPlain(label);
    case "SHIPPING_PRICE_CHANGED":
      return amount(issue.currentUnitPriceMinor)
        ? messages.shippingPriceChanged(formatPrice(issue.currentUnitPriceMinor, money))
        : t.server.orders.cartChanged;
    case "MARKET_UNAVAILABLE":
      return messages.marketUnavailable;
    default:
      return messages.ownerRejected(label);
  }
}
