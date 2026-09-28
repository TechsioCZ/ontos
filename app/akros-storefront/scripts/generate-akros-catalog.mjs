import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";
import { SaxesParser } from "saxes";

const storefrontRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(storefrontRoot, "..", "local", "akros");
const outputRoot = resolve(storefrontRoot, "src", "mock-storefront", "generated");
const categorySource = process.env.AKROS_CATEGORY_XML ?? resolve(sourceRoot, "category.xml");
const productSource = process.env.AKROS_PRODUCT_ZIP ?? resolve(sourceRoot, "product.xml.zip");
const akrosOrigin = "https://www.akros.cz";
const unavailableProductImage = "/akros/products/image-unavailable.svg";

const cleanText = (value = "") =>
  value
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/p>/gi, "\n")
    .replaceAll(/<\/li>/gi, "\n")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const toInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toMinorUnits = (value) => Math.round(Number.parseFloat(value || "0") * 100);

const absoluteAssetUrl = (value) => {
  const path = value?.trim();
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path.replace(/^\//, ""), `${akrosOrigin}/`).toString();
};

const parseXmlRows = (xml, rowName, onRow) => {
  const parser = new SaxesParser({ xmlns: false });
  const stack = [];
  let row;
  let text = "";

  parser.on("opentag", (node) => {
    stack.push(node.name);
    text = "";
    if (node.name === rowName) row = {};
  });

  parser.on("text", (value) => {
    text += value;
  });

  parser.on("cdata", (value) => {
    text += value;
  });

  parser.on("closetag", (node) => {
    const name = typeof node === "string" ? node : node.name;
    if (row && name !== rowName) {
      const path = stack.join("/");
      onRow.field?.(row, path, text.trim());
    }
    if (row && name === rowName) {
      onRow.complete(row);
      row = undefined;
    }
    stack.pop();
    text = "";
  });

  parser.write(xml).close();
};

const categories = [];
const categoryXml = readFileSync(categorySource, "utf8");
const categoryRowPattern = /<table name="category">([\s\S]*?)<\/table>/g;
for (const match of categoryXml.matchAll(categoryRowPattern)) {
  const columns = {};
  for (const column of match[1].matchAll(/<column name="([^"]+)">([\s\S]*?)<\/column>/g)) {
    columns[column[1]] = column[2]
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#039;", "'")
      .replaceAll("&amp;", "&");
  }
  if (columns.visible !== "1") continue;
  categories.push({
    id: columns.id,
    parentId: columns.id_parent || null,
    slug: columns.url || `category-${columns.id}`,
    name: cleanText(columns.title || columns.h1_title) || `Kategorie ${columns.id}`,
    heading: cleanText(columns.h1_title || columns.title),
    description: cleanText(columns.description),
    longDescription: cleanText(columns.long_description),
    position: toInteger(columns.position),
    imageSrc: absoluteAssetUrl(columns.icon),
    imageAlt: cleanText(columns.title || columns.h1_title),
  });
}

const categoryIds = new Set(categories.map((category) => category.id));
for (const category of categories) {
  if (!category.parentId || !categoryIds.has(category.parentId)) category.parentId = null;
}
const categoryIdsWithChildren = new Set(
  categories.map((category) => category.parentId).filter(Boolean),
);
for (const category of categories) {
  category.hasChildren = categoryIdsWithChildren.has(category.id);
}

const archive = unzipSync(new Uint8Array(readFileSync(productSource)), {
  filter: (entry) => entry.name === "product.xml",
});
const productXmlBytes = archive["product.xml"];
if (!productXmlBytes) throw new Error("product.xml is missing from the Akros archive");

const sourceItems = [];
let currentPrice;
let currentParameter;
const directItemFields = new Map([
  ["shop/item/id", "id"],
  ["shop/item/base_product", "baseProduct"],
  ["shop/item/id_product_group", "groupId"],
  ["shop/item/id_main_category", "categoryId"],
  ["shop/item/codes/user_code", "sku"],
  ["shop/item/domain", "domain"],
  ["shop/item/url", "slug"],
  ["shop/item/quantity", "stockCount"],
  ["shop/item/minimum_quantity", "minimumQuantity"],
  ["shop/item/content/variant_name", "variantName"],
  ["shop/item/content/title", "title"],
  ["shop/item/content/productname", "productName"],
  ["shop/item/content/description", "description"],
  ["shop/item/content/short_description", "shortDescription"],
  ["shop/item/measure_unit", "unit"],
  ["shop/item/preferences/action", "isAction"],
  ["shop/item/preferences/recommend", "isRecommended"],
  ["shop/item/preferences/sale", "isSale"],
  ["shop/item/preferences/news", "isNew"],
]);
parseXmlRows(new TextDecoder().decode(productXmlBytes), "item", {
  field(row, path, value) {
    if (path.endsWith("/price/exclude")) {
      currentPrice ??= {};
      currentPrice.exclude = value;
    } else if (path.endsWith("/price/value")) {
      currentPrice ??= {};
      currentPrice.value = value;
    } else if (path.endsWith("/price/valid_from_quantity")) {
      currentPrice ??= {};
      currentPrice.validFromQuantity = value;
    } else if (path.endsWith("/price/type")) {
      currentPrice ??= {};
      currentPrice.type = value;
    } else if (path.endsWith("/prices/price")) {
      row.prices ??= [];
      row.prices.push(currentPrice ?? {});
      currentPrice = undefined;
    } else if (path.endsWith("/parameter/title")) {
      currentParameter ??= {};
      currentParameter.title = value;
    } else if (path.endsWith("/parameter/unit")) {
      currentParameter ??= {};
      currentParameter.unit = value;
    } else if (path.endsWith("/parameter/values/value")) {
      currentParameter ??= {};
      currentParameter.values ??= [];
      currentParameter.values.push(value);
    } else if (path.endsWith("/parameters/parameter")) {
      row.parameters ??= [];
      row.parameters.push(currentParameter ?? {});
      currentParameter = undefined;
    } else if (path.endsWith("/images/image")) {
      row.images ??= [];
      row.images.push(value);
    } else {
      const field = directItemFields.get(path);
      if (field) row[field] = value;
    }
  },
  complete(row) {
    sourceItems.push(row);
    currentPrice = undefined;
    currentParameter = undefined;
  },
});

const priceTiersFor = (item) =>
  (item.prices ?? [])
    .filter((price) => price.value && (price.type === "default" || !price.type))
    .map((price) => ({
      minimumQuantity: Math.max(1, toInteger(price.validFromQuantity, 1)),
      priceMinor: toMinorUnits(price.value),
      priceExcludingVatMinor: toMinorUnits(price.exclude),
    }))
    .sort((left, right) => left.minimumQuantity - right.minimumQuantity);

const parametersFor = (item) =>
  (item.parameters ?? [])
    .map((parameter) => ({
      label: cleanText(parameter.title),
      value: (parameter.values ?? []).map(cleanText).filter(Boolean).join(", "),
      unit: cleanText(parameter.unit),
    }))
    .filter((parameter) => parameter.label && parameter.value);

const itemPrice = (item) => priceTiersFor(item)[0]?.priceMinor ?? 0;
const originalPriceFor = (item) => {
  const priceMinor = itemPrice(item);
  const isPromoted = Number(item.isAction) > 0 || Number(item.isSale) > 0;

  return isPromoted && priceMinor > 0 ? Math.round(priceMinor * 1.3) : undefined;
};
const itemImage = (item) => absoluteAssetUrl(item.images?.[0]);
const itemName = (item) => cleanText(item.productName || item.title) || `Produkt ${item.id}`;

const groups = new Map();
for (const item of sourceItems) {
  const groupId = item.groupId || item.id;
  const group = groups.get(groupId) ?? [];
  group.push(item);
  groups.set(groupId, group);
}

const usedSlugs = new Set();
const uniqueSlug = (candidate, groupId) => {
  const base = candidate || `produkt-${groupId}`;
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  const unique = `${base}-${groupId}`;
  usedSlugs.add(unique);
  return unique;
};

const products = [];
for (const [groupId, items] of groups) {
  const base = items.find((item) => item.baseProduct === "1") ?? items[0];
  const variantItems =
    items.length === 1
      ? []
      : base.baseProduct === "1"
        ? items.filter((item) => item !== base)
        : items;
  const purchasableItems = variantItems.length > 0 ? variantItems : [base];
  const lowestPrice = Math.min(...purchasableItems.map(itemPrice).filter((price) => price > 0));
  const imageSrc = items.map(itemImage).find(Boolean) ?? unavailableProductImage;
  const description = cleanText(base.shortDescription || base.description);
  const categoryId = categoryIds.has(base.categoryId) ? base.categoryId : categories[0]?.id;

  products.push({
    id: `product-${groupId}`,
    sourceGroupId: groupId,
    slug: uniqueSlug(base.slug, groupId),
    categoryId,
    name: itemName(base),
    sku: cleanText(base.sku),
    description,
    priceMinor: Number.isFinite(lowestPrice) ? lowestPrice : itemPrice(base),
    originalPriceMinor: variantItems.length === 0 ? originalPriceFor(base) : undefined,
    currency: "CZK",
    unit: cleanText(base.unit) || "ks",
    minimumQuantity: Math.max(1, toInteger(base.minimumQuantity, 1)),
    stockCount: purchasableItems.reduce(
      (total, item) => total + Math.max(0, toInteger(item.stockCount)),
      0,
    ),
    imageSrc,
    imageAlt: itemName(base),
    secondaryImageSrc: items.map((item) => absoluteAssetUrl(item.images?.[1])).find(Boolean),
    featuredPosition: null,
    isAction: items.some((item) => Number(item.isAction) > 0),
    isRecommended: items.some((item) => Number(item.isRecommended) > 0),
    isSale: items.some((item) => Number(item.isSale) > 0),
    isNew: items.some((item) => Number(item.isNew) > 0),
    detail: {
      descriptionParagraphs: description ? [description] : [],
      parameters: parametersFor(base),
      priceTiers: priceTiersFor(base),
      variants: variantItems.map((item) => ({
        id: `item-${item.id}`,
        sourceId: item.id,
        sku: cleanText(item.sku),
        label: cleanText(item.variantName || item.title || item.productName) || itemName(item),
        minimumQuantity: Math.max(1, toInteger(item.minimumQuantity, 1)),
        priceMinor: itemPrice(item),
        originalPriceMinor: originalPriceFor(item),
        priceTiers: priceTiersFor(item),
        stockCount: Math.max(0, toInteger(item.stockCount)),
        unit: cleanText(item.unit) || cleanText(base.unit) || "ks",
        parameters: parametersFor(item),
        imageSrc: itemImage(item),
        isAction: Number(item.isAction) > 0,
        isRecommended: Number(item.isRecommended) > 0,
        isSale: Number(item.isSale) > 0,
        isNew: Number(item.isNew) > 0,
      })),
    },
  });
}

products.sort((left, right) => left.name.localeCompare(right.name, "cs"));

const preferredFeaturedSlugs = [
  "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
  "retezy-nerezove-kratky-clanek-din-766-a4",
  "tyce-kruhove-valcovane-za-tepla-mat-1-4301",
  "podlozky-ploche-din-125a-a2",
];
const homepageFeaturedProductIds = preferredFeaturedSlugs
  .map((slug) => products.find((product) => product.slug === slug)?.id)
  .filter(Boolean);
if (homepageFeaturedProductIds.length < 4) {
  for (const product of products) {
    if (homepageFeaturedProductIds.includes(product.id) || product.priceMinor <= 0) continue;
    homepageFeaturedProductIds.push(product.id);
    if (homepageFeaturedProductIds.length === 4) break;
  }
}
homepageFeaturedProductIds.forEach((id, position) => {
  const product = products.find((candidate) => candidate.id === id);
  if (product) product.featuredPosition = position + 1;
});

if (!products.some((product) => product.isNew)) {
  const preferredNewProducts = homepageFeaturedProductIds.flatMap((id) => {
    const product = products.find((candidate) => candidate.id === id);
    return product ? [product] : [];
  });
  const fallbackNewProducts = [...preferredNewProducts, ...products]
    .filter(
      (product, index, candidates) =>
        candidates.findIndex((candidate) => candidate.id === product.id) === index &&
        product.name.trim().toLocaleUpperCase("cs-CZ") !== "AKCE" &&
        product.priceMinor > 0 &&
        product.imageSrc !== unavailableProductImage,
    )
    .slice(0, 30);

  for (const product of fallbackNewProducts) product.isNew = true;
}

const metadata = {
  sourceCategoryCount: categories.length,
  sourceItemCount: sourceItems.length,
  productGroupCount: products.length,
};

mkdirSync(outputRoot, { recursive: true });
writeFileSync(
  resolve(outputRoot, "categories.generated.json"),
  `${JSON.stringify({ metadata, categories }, null, 2)}\n`,
);
writeFileSync(
  resolve(outputRoot, "catalog.generated.json"),
  `${JSON.stringify({ metadata, homepageFeaturedProductIds, products }, null, 2)}\n`,
);

console.log(
  `Generated ${metadata.productGroupCount} product groups from ${metadata.sourceItemCount} items and ${metadata.sourceCategoryCount} categories.`,
);
