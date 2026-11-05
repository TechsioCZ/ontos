import { Schema, Struct } from "effect";
import { isStorefrontMediaPath, productMediaPath } from "./media-path";

const optionalNumber = Schema.optionalKey(Schema.Number);
const optionalString = Schema.optionalKey(Schema.String);
const StoreCurrencySchema = Schema.Literals(["CZK", "EUR", "PLN"]);
const VariantPreviewItemsSchema = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String }),
).check(Schema.isMaxLength(3));
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
      categoryId: optionalString,
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
      packageQuantity: optionalNumber,
      parameters: Schema.optionalKey(ParametersSchema),
      priceTiers: Schema.optionalKey(PriceTiersSchema),
      published: Schema.optionalKey(Schema.Boolean),
      sku: optionalString,
      slug: Schema.String,
      sourceProductId: optionalString,
      stockOnHand: optionalNumber,
      stockTracked: Schema.optionalKey(Schema.Boolean),
      storefrontVariantPreview: Schema.optionalKey(
        Schema.Struct({
          total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          variants: VariantPreviewItemsSchema,
        }),
      ),
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
            packageQuantity: optionalNumber,
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
  minimumQuantity: optionalNumber,
  name: Schema.String,
  packageQuantity: optionalNumber,
  priceExcludingVatMinor: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  ),
  priceFrom: Schema.Boolean,
  priceMinor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  sku: Schema.String,
  slug: Schema.String,
  stock: Schema.Literals(["available", "limited", "unavailable", "unknown"]),
  unit: optionalString,
  variantCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  variantPreview: Schema.optionalKey(VariantPreviewItemsSchema),
});

export type ProductCardModel = typeof ProductCardModelSchema.Type;

interface ProductVariantModel {
  readonly attributes: string;
  readonly id: string;
  readonly image: string | null;
  readonly minimumQuantity: number;
  readonly name: string;
  readonly packageQuantity?: number;
  readonly parameters: typeof ParametersSchema.Type;
  readonly priceExcludingVatMinor: number | null;
  readonly priceMinor: number | null;
  readonly sku: string;
  readonly stock: ProductCardModel["stock"];
  readonly stockQuantity: number | null;
  readonly unit: string;
}

export interface ProductDetailModel extends ProductCardModel {
  readonly categoryId: string | null;
  readonly imageAlt: string;
  readonly images: readonly string[];
  readonly manufacturer?: string;
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
  if (isStorefrontMediaPath(source)) {
    return source;
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

/** A product photo: an uploaded media reference is served from this storefront, anything else must be public HTTPS. */
const imageOf = (
  productId: string,
  source: string | undefined,
  hosts: readonly string[],
): string | null => {
  const uploaded = source === undefined ? undefined : productMediaPath(productId, source);
  return uploaded ?? publicImage(source, hosts);
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
      image: imageOf(product.id, variant.imageSrc, hosts),
      minimumQuantity: variant.minimumQuantity ?? 1,
      name: variant.name,
      ...Struct.pick(variant, ["packageQuantity"]),
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

/** The audited N1 import joins producer.title into this parameter; other brands are not inferred. */
const manufacturerOf = (product: OwnerProduct): string | undefined => {
  if (
    product.sourceProductId === undefined ||
    product.sourceProductId.trim() !== product.sourceProductId ||
    !/^n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:product:\d+$/u.test(
      product.sourceProductId,
    )
  ) {
    return undefined;
  }
  const candidates = (product.parameters ?? []).filter((parameter) => parameter.label === "Značka");
  const [candidate] = candidates;
  return candidates.length === 1 &&
    candidate?.unit === "" &&
    candidate.value.trim().length > 0 &&
    candidate.value.trim() !== "Bez výrobce"
    ? candidate.value
    : undefined;
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
  const manufacturer = manufacturerOf(product);
  const detail: ProductDetailModel = {
    ...card,
    categoryId: product.categoryId ?? null,
    imageAlt: product.imageAlt ?? product.name,
    images: [
      ...new Set(
        gallery
          .map((source) => imageOf(product.id, source, hosts))
          .filter((source) => source !== null),
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
  return manufacturer === undefined ? detail : { ...detail, manufacturer };
};

/** Preserve explicit count evidence; absence or contradictory owner counts stays unknown. */
const variantCountOf = (product: OwnerProduct): number | undefined => {
  const previewCount = product.storefrontVariantPreview?.total;
  const summaryCount = product.variantSummary?.count;
  if (previewCount !== undefined && summaryCount !== undefined && previewCount !== summaryCount) {
    return undefined;
  }
  const count = previewCount ?? summaryCount;
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
};

/** A group minimum or an inactive-variant parent cannot prove the displayed card's net price. */
const cardNetPriceOf = (product: OwnerProduct, card: ProductCardModel): number | null => {
  if (
    card.variantCount !== 0 ||
    (card.variantPreview?.length ?? 0) > 0 ||
    (card.stock !== "available" && card.stock !== "limited") ||
    (product.variantSummary?.minGrossPriceMinor ?? null) !== null
  ) {
    return null;
  }
  return netPriceOf(product.currentPriceMinor, product.priceTiers, card.priceMinor);
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
      ...Struct.pick(product, ["minimumQuantity", "packageQuantity", "unit"]),
      currency: body.market.currency,
      description: product.description ?? "",
      id: product.id,
      image: imageOf(
        product.id,
        product.gallery === undefined ? product.imageSrc : product.gallery[0],
        hosts,
      ),
      name: product.name,
      priceFrom: (product.variantSummary?.count ?? 0) > 1,
      priceMinor: priceOf(product, body.market.currency),
      sku: product.sku ?? "",
      slug: product.slug,
      stock: stockStatus(product),
      variantPreview: product.storefrontVariantPreview?.variants ?? [],
    };
    const variantCount = variantCountOf(product);
    if (variantCount !== undefined) {
      Object.assign(card, { variantCount });
    }
    const priceExcludingVatMinor = cardNetPriceOf(product, card);
    if (priceExcludingVatMinor !== null) {
      Object.assign(card, { priceExcludingVatMinor });
    }
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
