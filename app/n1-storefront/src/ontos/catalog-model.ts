import { Schema, Struct } from "effect";
import { categoryForestIssue } from "@app/merchandise/domain/category-forest";
import { isStorefrontMediaPath, productMediaPath } from "./media-path";

const optionalNumber = Schema.optionalKey(Schema.Number);
const optionalString = Schema.optionalKey(Schema.String);
// Staff-edited OntOS fields the N1 design did not originally render; read leniently so one odd value never hides the catalogue.
const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const ownerFlagFields = {
  flags: optionalUnknown,
  isAction: optionalUnknown,
  isNew: optionalUnknown,
  isRecommended: optionalUnknown,
  isSale: optionalUnknown,
  labels: optionalUnknown,
  originalPriceMinor: optionalUnknown,
  sourceUnit: optionalUnknown,
  weightGrams: optionalUnknown,
};
export const ProductLabelSchema = Schema.Literals(["action", "new", "recommended", "sale"]);
export type ProductLabel = typeof ProductLabelSchema.Type;
const productLabels: readonly ProductLabel[] = ["action", "new", "recommended", "sale"];
const flagKey = { action: "isAction", new: "isNew", recommended: "isRecommended", sale: "isSale" };
/** The four OntOS storefront labels, set as booleans, a nested flags object or a labels list. */
const labelsOf = (record: Readonly<Record<string, unknown>>): ProductLabel[] => {
  const nested =
    typeof record.flags === "object" && record.flags !== null
      ? (record.flags as Readonly<Record<string, unknown>>)
      : {};
  const all = { ...record, ...nested };
  const listed = Array.isArray(all.labels) ? all.labels : [];
  return productLabels.filter((label) => all[flagKey[label]] === true || listed.includes(label));
};
const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const filled = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
    ).check(
      Schema.makeFilter(
        (categories) => categoryForestIssue(categories, "projection") === undefined,
      ),
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
      ...ownerFlagFields,
      brand: optionalString,
      categoryId: optionalString,
      heightMm: optionalUnknown,
      lengthMm: optionalUnknown,
      widthMm: optionalUnknown,
      currency: optionalString,
      currentPriceMinor: optionalNumber,
      description: optionalString,
      descriptionParagraphs: Schema.optionalKey(Schema.Array(Schema.String)),
      documents: Schema.optionalKey(
        Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
      ),
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
      relatedProductIds: Schema.optionalKey(Schema.Array(Schema.String)),
      seoDescription: optionalString,
      seoTitle: optionalString,
      shortDescription: optionalString,
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
            ...ownerFlagFields,
            attributes: Schema.String,
            availability: Schema.String,
            description: optionalUnknown,
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
  labels: Schema.optionalKey(Schema.Array(ProductLabelSchema)),
  minimumQuantity: optionalNumber,
  name: Schema.String,
  originalPriceMinor: optionalNumber,
  packageQuantity: optionalNumber,
  priceExcludingVatMinor: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  ),
  priceFrom: Schema.Boolean,
  priceMinor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  sku: Schema.String,
  slug: Schema.String,
  stock: Schema.Literals(["available", "limited", "unavailable", "unknown"]),
  stockQuantity: Schema.optionalKey(
    Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  unit: optionalString,
  variantCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  variantPreview: Schema.optionalKey(VariantPreviewItemsSchema),
});

export type ProductCardModel = typeof ProductCardModelSchema.Type;

export interface QuantityPriceModel {
  readonly minimumQuantity: number;
  readonly priceMinor: number;
}

interface ProductVariantModel {
  readonly attributes: string;
  readonly description: string;
  readonly id: string;
  readonly image: string | null;
  readonly labels?: readonly ProductLabel[];
  readonly minimumQuantity: number;
  readonly name: string;
  readonly originalPriceMinor?: number | null;
  readonly priceTiers: readonly QuantityPriceModel[];
  readonly weightGrams: number | null;
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
  readonly dimensionsText: string | null;
  readonly documents: readonly { readonly label: string; readonly url: string }[];
  readonly imageAlt: string;
  readonly images: readonly string[];
  readonly manufacturer?: string;
  readonly minimumQuantity: number;
  readonly paragraphs: readonly string[];
  readonly parameters: typeof ParametersSchema.Type;
  readonly priceExcludingVatMinor: number | null;
  readonly priceTiers: readonly QuantityPriceModel[];
  readonly relatedProductIds: readonly string[];
  readonly seoDescription: string;
  readonly seoTitle: string;
  readonly stockQuantity: number | null;
  readonly unit: string;
  readonly variants: readonly ProductVariantModel[];
  readonly weightGrams: number | null;
}

/** Quantity prices above the base price, lowest quantity first. */
const quantityPricesOf = (
  tiers: typeof PriceTiersSchema.Type | undefined,
  minimum: number,
): QuantityPriceModel[] =>
  (tiers ?? [])
    .filter(
      (tier) =>
        Number.isSafeInteger(tier.priceMinor) &&
        tier.priceMinor > 0 &&
        Number.isFinite(tier.minimumQuantity) &&
        tier.minimumQuantity > minimum,
    )
    .map((tier) => ({ minimumQuantity: tier.minimumQuantity, priceMinor: tier.priceMinor }))
    .sort((a, b) => a.minimumQuantity - b.minimumQuantity);

const originalOf = (original: unknown, price: number | null): number | null => {
  const amount = positive(original);
  return amount !== undefined && price !== null && Number.isSafeInteger(amount) && amount > price
    ? amount
    : null;
};

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
    const priceMinor = priceOf(individual, card.currency);
    const minimumQuantity = variant.minimumQuantity ?? 1;
    variants.push({
      attributes: variant.attributes,
      description: filled(variant.description) ?? "",
      id: variant.id,
      image: imageOf(product.id, variant.imageSrc, hosts),
      labels: labelsOf(variant),
      minimumQuantity,
      name: variant.name,
      originalPriceMinor: originalOf(variant.originalPriceMinor, priceMinor),
      priceTiers: quantityPricesOf(variant.priceTiers, minimumQuantity),
      weightGrams: positive(variant.weightGrams) ?? null,
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
      unit:
        filled(variant.sourceUnit) ??
        variant.unit ??
        filled(product.sourceUnit) ??
        product.unit ??
        "",
    });
  }
  return variants;
};

/** The audited N1 import joins producer.title into this parameter; other brands are not inferred. */
const manufacturerOf = (product: OwnerProduct): string | undefined => {
  const brand = product.brand?.trim();
  if (brand !== undefined && brand.length > 0) {
    return brand;
  }
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

const detailImagesOf = (product: OwnerProduct, hosts: readonly string[]) => {
  const gallery =
    product.gallery ??
    (product.imageSrc !== undefined && product.imageSrc.length > 0 ? [product.imageSrc] : []);
  return [
    ...new Set(
      gallery
        .map((source) => imageOf(product.id, source, hosts))
        .filter((source) => source !== null),
    ),
  ];
};

const detailParagraphsOf = (product: OwnerProduct, fallback: string) => {
  if (product.descriptionParagraphs !== undefined) {
    return product.descriptionParagraphs;
  }
  const description = product.description ?? fallback;
  return description.length > 0 ? [description] : [];
};

const dimensionsOf = (product: OwnerProduct): string | null => {
  const sizes = [product.lengthMm, product.widthMm, product.heightMm].flatMap((value) => {
    const mm = positive(value);
    return mm === undefined ? [] : [mm.toLocaleString("cs-CZ")];
  });
  return sizes.length > 0 ? `${sizes.join(" × ")} mm` : null;
};

/** A group shows the struck price of its cheapest active variant; a simple product its own. */
const cardOriginalOf = (product: OwnerProduct, price: number | null): number | null => {
  if ((product.variantSummary?.count ?? 0) === 0) {
    return originalOf(product.originalPriceMinor, price);
  }
  const cheapest = (product.variantRecords ?? []).find(
    (variant) => variant.active && variant.grossPriceMinor === price,
  );
  return cheapest === undefined ? null : originalOf(cheapest.originalPriceMinor, price);
};

const detailOf = (
  product: OwnerProduct,
  card: ProductCardModel,
  hosts: readonly string[],
): ProductDetailModel => {
  const variants = variantDetailsOf(product, card, hosts);
  const manufacturer = manufacturerOf(product);
  const detail: ProductDetailModel = {
    ...card,
    categoryId: product.categoryId ?? null,
    dimensionsText: dimensionsOf(product),
    documents: (product.documents ?? []).filter(
      (document) =>
        document.label.trim().length > 0 &&
        (document.url.startsWith("https://") ||
          (document.url.startsWith("/") && !document.url.startsWith("//"))),
    ),
    imageAlt: product.imageAlt ?? product.name,
    images: detailImagesOf(product, hosts),
    minimumQuantity:
      product.minimumQuantity !== undefined && product.minimumQuantity > 0
        ? product.minimumQuantity
        : 1,
    paragraphs: detailParagraphsOf(product, card.description),
    parameters: product.parameters ?? [],
    priceExcludingVatMinor:
      variants.length > 0 || (product.variantSummary?.count ?? 0) > 0
        ? null
        : netPriceOf(product.currentPriceMinor, product.priceTiers, card.priceMinor),
    priceTiers:
      variants.length > 0 ? [] : quantityPricesOf(product.priceTiers, product.minimumQuantity ?? 1),
    relatedProductIds: (product.relatedProductIds ?? []).filter(
      (id) => id.length > 0 && id !== product.id,
    ),
    seoDescription: product.seoDescription?.trim() ?? "",
    seoTitle: product.seoTitle?.trim() ?? "",
    stockQuantity: stockQuantityOf(product),
    unit: card.unit ?? "",
    variants,
    weightGrams: variants.length > 0 ? null : (positive(product.weightGrams) ?? null),
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
    const unit = filled(product.sourceUnit) ?? product.unit;
    const card: ProductCardModel = {
      ...Struct.pick(product, ["minimumQuantity", "packageQuantity"]),
      ...(unit === undefined ? {} : { unit }),
      currency: body.market.currency,
      description:
        (product.shortDescription ?? "").length > 0
          ? (product.shortDescription ?? "")
          : (product.description ?? ""),
      id: product.id,
      image: imageOf(
        product.id,
        product.gallery === undefined ? product.imageSrc : product.gallery[0],
        hosts,
      ),
      labels: labelsOf(product),
      name: product.name,
      priceFrom: (product.variantSummary?.count ?? 0) > 1,
      priceMinor: priceOf(product, body.market.currency),
      sku: product.sku ?? "",
      slug: product.slug,
      stock: stockStatus(product),
      stockQuantity: stockQuantityOf(product),
      variantPreview: product.storefrontVariantPreview?.variants ?? [],
    };
    const variantCount = variantCountOf(product);
    if (variantCount !== undefined) {
      Object.assign(card, { variantCount });
    }
    const originalPriceMinor = cardOriginalOf(product, card.priceMinor);
    if (originalPriceMinor !== null) {
      Object.assign(card, { originalPriceMinor });
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
