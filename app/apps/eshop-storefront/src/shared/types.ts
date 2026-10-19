// Wire types between the storefront BFF (server/*) and the browser (src/*). No secrets, no staff data.

/** Owner availability. UNKNOWN means „nelze ověřit“ — never shown as in stock. */
export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';

export interface StoreVariant {
  readonly id: string;
  /** Customer-facing label, e.g. „250 g / zrnková“. */
  readonly label: string;
  /** Option values parsed from the label/attributes, e.g. { Hmotnost: '250 g', Mletí: 'zrnková' }. */
  readonly options: Readonly<Record<string, string>>;
  readonly sku: string;
  /** Gross unit price (incl. VAT) in CZK minor units from the merchandise owner; null = cena není dostupná. */
  readonly priceMinor: number | null;
  readonly availability: Availability;
  /** Units the owner reports as available; only present for tracked stock. */
  readonly availableQuantity: number | null;
}

export interface StoreCategory {
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
  readonly art: string;
}

export interface StoreProductSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly category: { readonly slug: string; readonly name: string };
  readonly shortDescription: string | null;
  readonly image: string;
  /** Lowest gross variant price, null when no variant has a price. */
  readonly priceFromMinor: number | null;
  /** True when variants have different prices („od …“). */
  readonly priceVaries: boolean;
  readonly availability: Availability;
  readonly variantCount: number;
  readonly vatRate: number;
}

export interface StoreProduct extends StoreProductSummary {
  readonly description: string | null;
  readonly images: readonly string[];
  readonly variants: readonly StoreVariant[];
  readonly unit: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

export interface CatalogResponse {
  readonly categories: readonly StoreCategory[];
  readonly products: readonly StoreProductSummary[];
  readonly total: number;
  readonly priceBounds: { readonly minMinor: number; readonly maxMinor: number } | null;
  readonly fetchedAt: string;
}

export interface HomeResponse {
  readonly categories: readonly StoreCategory[];
  readonly bestsellers: readonly StoreProductSummary[];
  readonly newest: readonly StoreProductSummary[];
  readonly productCount: number;
  readonly fetchedAt: string;
}

export interface CartLineInput {
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
  /** Gross unit price the customer last accepted. */
  readonly priceMinor: number | null;
}

export type CartLineStatus = 'OK' | 'PRICE_CHANGED' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK' | 'UNKNOWN_AVAILABILITY' | 'NO_PRICE' | 'NOT_FOUND';

export interface CartLineCheck {
  readonly productId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly status: CartLineStatus;
  readonly message: string | null;
  readonly name: string | null;
  readonly slug: string | null;
  readonly variantLabel: string | null;
  readonly sku: string | null;
  readonly image: string | null;
  readonly acceptedPriceMinor: number | null;
  readonly currentPriceMinor: number | null;
  readonly availability: Availability | null;
  readonly availableQuantity: number | null;
}

export interface CartValidation {
  readonly lines: readonly CartLineCheck[];
  /** Sum of current gross prices × quantity, computed by the BFF from owner prices. */
  readonly subtotalMinor: number | null;
  readonly canCheckout: boolean;
  readonly checkedAt: string;
}

export type ShippingMethodId = 'ZASILKOVNA' | 'PPL' | 'CESKA_POSTA' | 'OSOBNI_ODBER';

export interface ShippingOption {
  readonly id: ShippingMethodId;
  readonly label: string;
  readonly description: string;
  readonly priceMinor: number;
}

export interface OrderRequest {
  readonly submissionId: string;
  readonly lines: readonly CartLineInput[];
  readonly contact: { readonly name: string; readonly email: string; readonly phone?: string };
  readonly address: { readonly street: string; readonly city: string; readonly postalCode: string; readonly country?: string };
  readonly shippingMethod: ShippingMethodId;
  readonly expectedShippingPriceMinor: number;
  readonly note?: string;
}

export interface PlacedOrder {
  readonly submissionId: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly createdAt: string | null;
  readonly lines: readonly {
    readonly name: string;
    readonly variantLabel: string | null;
    readonly sku: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly lineTotalMinor: number;
  }[];
  readonly shipping: { readonly label: string; readonly priceMinor: number } | null;
  readonly totalMinor: number | null;
  readonly totalVatMinor: number | null;
  readonly contactName: string | null;
  readonly replayed: boolean;
}

export interface OrderIssue {
  readonly code: string;
  readonly message: string;
  readonly productId?: string;
  readonly variantId?: string;
  readonly currentUnitPriceMinor?: number;
  readonly expectedUnitPriceMinor?: number;
}

export interface ApiProblem {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly OrderIssue[];
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

export const DEMO_DISCLAIMER = 'E-shop je prezentační demo. Žádné zboží vám nebude doručeno a nic neplatíte.';
export const DEMO_RIBBON = 'DEMO – objednávky se jen ukládají pro ukázku; nic neplatíte a nic vám nedoručíme';
