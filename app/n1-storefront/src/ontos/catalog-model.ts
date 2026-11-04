import { Schema, Struct } from "effect";

const optionalNumber = Schema.optionalKey(Schema.Number);
const optionalString = Schema.optionalKey(Schema.String);
const StoreCurrencySchema = Schema.Literals(["CZK", "EUR", "PLN"]);
const ParametersSchema = Schema.Array(
  Schema.Struct({ label: Schema.String, unit: Schema.String, value: Schema.String }),
);
const PriceTiersSchema = Schema.Array(
  Schema.Struct({
    minimumQuantity: Schema.Number,
    priceExcludingVatMinor: optionalNumber,
    priceMinor: Schema.Number,
  }),
);
export const CatalogResponseSchema = Schema.Struct({
  categories: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        imageSrc: optionalString,
        name: Schema.String,
        parentId: Schema.NullOr(Schema.String),
        published: Schema.optionalKey(Schema.Boolean),
        slug: Schema.String,
      }),
    ),
  ),
  market: Schema.Struct({
    configured: Schema.Boolean,
    currency: StoreCurrencySchema,
    marketId: Schema.String,
  }),
  page: optionalNumber,
  pageSize: optionalNumber,
  products: Schema.Array(
    Schema.Struct({
      active: Schema.optionalKey(Schema.Boolean),
      availability: optionalString,
      currency: optionalString,
      currentPriceMinor: optionalNumber,
      description: optionalString,
      descriptionParagraphs: Schema.optionalKey(Schema.Array(Schema.String)),
      gallery: Schema.optionalKey(Schema.Array(Schema.String)),
      grossPriceMinor: optionalNumber,
      id: Schema.String,
      imageAlt: optionalString,
      imageSrc: optionalString,
      minimumQuantity: optionalNumber,
      name: Schema.String,
      parameters: Schema.optionalKey(ParametersSchema),
      priceTiers: Schema.optionalKey(PriceTiersSchema),
      published: Schema.optionalKey(Schema.Boolean),
      sku: optionalString,
      slug: Schema.String,
      stockOnHand: optionalNumber,
      stockTracked: Schema.optionalKey(Schema.Boolean),
      unit: optionalString,
      variantRecords: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            active: Schema.Boolean,
            attributes: Schema.String,
            availability: Schema.String,
            grossPriceMinor: Schema.Number,
            id: Schema.String,
            imageSrc: optionalString,
            minimumQuantity: optionalNumber,
            name: Schema.String,
            parameters: Schema.optionalKey(ParametersSchema),
            priceMinor: optionalNumber,
            priceTiers: Schema.optionalKey(PriceTiersSchema),
            sku: Schema.String,
            stockOnHand: Schema.Number,
            unit: optionalString,
          }),
        ),
      ),
      variantSummary: Schema.optionalKey(
        Schema.Struct({
          count: Schema.Number,
          minGrossPriceMinor: Schema.NullOr(Schema.Number),
          stockOnHand: Schema.Number,
        }),
      ),
    }),
  ),
  total: optionalNumber,
});

export const ProductCardModelSchema = Schema.Struct({
  currency: StoreCurrencySchema,
  description: Schema.String,
  id: Schema.String,
  image: Schema.NullOr(Schema.String),
  name: Schema.String,
  priceFrom: Schema.Boolean,
  priceMinor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  sku: Schema.String,
  slug: Schema.String,
  stock: Schema.Literals(["available", "limited", "unavailable", "unknown"]),
  variantCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type ProductCardModel = typeof ProductCardModelSchema.Type;

interface ProductVariantModel {
  readonly attributes: string;
  readonly id: string;
  readonly image: string | null;
  readonly minimumQuantity: number;
  readonly name: string;
  readonly parameters: typeof ParametersSchema.Type;
  readonly priceExcludingVatMinor: number | null;
  readonly priceMinor: number | null;
  readonly sku: string;
  readonly stock: ProductCardModel["stock"];
  readonly stockQuantity: number | null;
  readonly unit: string;
}

export interface ProductDetailModel extends ProductCardModel {
  readonly imageAlt: string;
  readonly images: readonly string[];
  readonly minimumQuantity: number;
  readonly paragraphs: readonly string[];
  readonly parameters: typeof ParametersSchema.Type;
  readonly priceExcludingVatMinor: number | null;
  readonly stockQuantity: number | null;
  readonly unit: string;
  readonly variants: readonly ProductVariantModel[];
}

/** Only approved public image origins; media references need an owner media read, never a guessed URL. */
export const publicImage = (
  source: string | undefined,
  hosts: readonly string[],
): string | null => {
  if (source === undefined || source.length === 0) {
    return null;
  }
  try {
    const url = new URL(source);
    return url.protocol === "https:" && !url.username && !url.password && hosts.includes(url.host)
      ? url.href
      : null;
  } catch {
    return null;
  }
};

type OwnerProduct = (typeof CatalogResponseSchema.Type.products)[number];

const priceOf = (product: OwnerProduct, currency: string): number | null => {
  const grouped = (product.variantSummary?.count ?? 0) > 0;
  const price = grouped ? product.variantSummary?.minGrossPriceMinor : product.grossPriceMinor;
  if (
    price === undefined ||
    price === null ||
    !Number.isSafeInteger(price) ||
    price <= 0 ||
    (product.currency !== undefined && product.currency !== currency)
  ) {
    return null;
  }
  return price;
};

const stockStatus = (product: OwnerProduct): ProductCardModel["stock"] => {
  if (
    product.stockTracked === false ||
    !["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(product.availability ?? "")
  ) {
    return "unknown";
  }
  const count = product.variantSummary?.count ?? 0;
  const stock = count > 0 ? (product.variantSummary?.stockOnHand ?? 0) : (product.stockOnHand ?? 0);
  if (product.availability === "OUT_OF_STOCK" || stock <= 0) {
    return "unavailable";
  }
  return product.availability === "LOW_STOCK" ? "limited" : "available";
};

/** A group sum never describes the stock of a yet unselected variant. */
const stockQuantityOf = (product: OwnerProduct): number | null => {
  const quantity = product.stockOnHand;
  if (
    (product.variantSummary?.count ?? 0) > 0 ||
    product.variantRecords?.some((variant) => variant.active) === true ||
    stockStatus(product) === "unknown" ||
    quantity === undefined ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    (product.availability === "OUT_OF_STOCK" && quantity > 0)
  ) {
    return null;
  }
  return quantity;
};

/** Preserve an explicit owner gross/net pair; never derive tax or convert currency here. */
const netPriceOf = (
  baseNet: number | undefined,
  tiers: typeof PriceTiersSchema.Type | undefined,
  gross: number | null,
): number | null => {
  if (gross === null) {
    return null;
  }
  const candidates = new Set<number | undefined>();
  if (tiers !== undefined && tiers.length > 0) {
    for (const tier of tiers) {
      if (tier.priceMinor === gross) {
        candidates.add(tier.priceExcludingVatMinor);
      }
    }
  } else {
    candidates.add(baseNet);
  }
  const [net] = candidates;
  return candidates.size === 1 &&
    net !== undefined &&
    Number.isSafeInteger(net) &&
    net > 0 &&
    net <= gross
    ? net
    : null;
};

const variantDetailsOf = (
  product: OwnerProduct,
  card: ProductCardModel,
  hosts: readonly string[],
): readonly ProductVariantModel[] => {
  const variants: ProductVariantModel[] = [];
  for (const variant of product.variantRecords ?? []) {
    if (!variant.active) {
      continue;
    }
    const individual: OwnerProduct = {
      availability: variant.availability,
      ...Struct.pick(product, ["currency"]),
      grossPriceMinor: variant.grossPriceMinor,
      id: variant.id,
      name: variant.name,
      slug: product.slug,
      stockOnHand: variant.stockOnHand,
      stockTracked: product.stockTracked ?? true,
    };
    variants.push({
      attributes: variant.attributes,
      id: variant.id,
      image: publicImage(variant.imageSrc, hosts),
      minimumQuantity: variant.minimumQuantity ?? product.minimumQuantity ?? 1,
      name: variant.name,
      parameters: variant.parameters ?? [],
      priceExcludingVatMinor: netPriceOf(
        variant.priceMinor,
        variant.priceTiers,
        priceOf(individual, card.currency),
      ),
      priceMinor: priceOf(individual, card.currency),
      sku: variant.sku,
      stock: stockStatus(individual),
      stockQuantity: stockQuantityOf(individual),
      unit: variant.unit ?? product.unit ?? "",
    });
  }
  return variants;
};

const detailOf = (
  product: OwnerProduct,
  card: ProductCardModel,
  hosts: readonly string[],
): ProductDetailModel => {
  const gallery =
    product.gallery ??
    (product.imageSrc !== undefined && product.imageSrc.length > 0 ? [product.imageSrc] : []);
  const variants = variantDetailsOf(product, card, hosts);
  return {
    ...card,
    imageAlt: product.imageAlt ?? product.name,
    images: [
      ...new Set(
        gallery.map((source) => publicImage(source, hosts)).filter((source) => source !== null),
      ),
    ],
    minimumQuantity:
      product.minimumQuantity !== undefined && product.minimumQuantity > 0
        ? product.minimumQuantity
        : 1,
    paragraphs:
      product.descriptionParagraphs ?? (card.description.length > 0 ? [card.description] : []),
    parameters: product.parameters ?? [],
    priceExcludingVatMinor:
      variants.length > 0 || (product.variantSummary?.count ?? 0) > 0
        ? null
        : netPriceOf(product.currentPriceMinor, product.priceTiers, card.priceMinor),
    stockQuantity: stockQuantityOf(product),
    unit: product.unit ?? "",
    variants,
  };
};

export const projectCatalog = (
  body: typeof CatalogResponseSchema.Type,
  hosts: readonly string[],
) => {
  const products: ProductCardModel[] = [];
  const details: ProductDetailModel[] = [];
  for (const product of body.products) {
    if (product.active === false || product.published === false) {
      continue;
    }
    const card: ProductCardModel = {
      currency: body.market.currency,
      description: product.description ?? "",
      id: product.id,
      image: publicImage(
        product.gallery === undefined ? product.imageSrc : product.gallery[0],
        hosts,
      ),
      name: product.name,
      priceFrom: (product.variantSummary?.count ?? 0) > 1,
      priceMinor: priceOf(product, body.market.currency),
      sku: product.sku ?? "",
      slug: product.slug,
      stock: stockStatus(product),
      variantCount: product.variantSummary?.count ?? 0,
    };
    products.push(card);
    details.push(detailOf(product, card, hosts));
  }
  return {
    categories: (body.categories ?? []).filter((category) => category.published !== false),
    configured: body.market.configured,
    currency: body.market.currency,
    details,
    page: body.page ?? 1,
    pageSize: body.pageSize ?? 24,
    products,
    total: body.total ?? 0,
  };
};

export type CatalogModel = ReturnType<typeof projectCatalog>;
