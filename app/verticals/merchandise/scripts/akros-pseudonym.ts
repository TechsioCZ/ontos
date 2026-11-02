import { Effect } from 'effect';
import { buildAkrosEncodedFrom } from './akros-baseline.ts';
import type { AkrosEncodedState, AkrosSource, DemoId } from './akros-baseline.ts';

/** Czech copy rewrites are ordered: whole grammatical phrases before declined brand names. */
const assortmentPhrase = (preposition: string, noun: string) => {
  if (noun.toLowerCase() === 'nabídce') {
    return `${preposition} naší nabídce`;
  }
  if (noun.toLowerCase() === 'nabídky') {
    return `${preposition} naší nabídky`;
  }
  return `${preposition} našem sortimentu`;
};
export const neutralCatalogText = (text: string): string =>
  text
    .replaceAll(
      /\b(?<preposition>v|z)\s+(?<noun>nabídce|nabídky|sortimentu)\s+akros(?:u|\.cz)?\b/giu,
      (_match, preposition: string, noun: string) => assortmentPhrase(preposition, noun),
    )
    .replaceAll(/\bna\s+(?:webu|e-shopu)\s+akros(?:\.cz)?\b/giu, 'V našem obchodě')
    .replaceAll(/\bv\s+akros\s+nabídce\b/giu, 'V naší nabídce')
    .replaceAll(/\bv\s+akros\b/giu, 'V našem obchodě')
    .replaceAll(/\bu\s+akrosu\b/giu, 'u nás')
    .replaceAll(/\b(?:z|od)\s+akrosu?\b/giu, 'z naší nabídky')
    .replaceAll(/\bakros(?:\.cz)?\s+nabízí(?!\p{L})/giu, 'Nabízíme')
    .replaceAll(/\bakros\s+kovovýroba\b/giu, 'Naše kovovýroba')
    .replaceAll(/\bs\s+akrosem\b/giu, 'se ŠroubShopem')
    .replaceAll(/\bakrosem\b/giu, 'ŠroubShopem')
    .replaceAll(/\bakrosu\b/giu, 'ŠroubShopu')
    .replaceAll(/akros(?:\.cz)?/giu, 'ŠroubShop');

export const isSourceCatalogImage = (image: string) =>
  /^https:\/\/www\.akros\.cz\/data\/(?:product|category)\/[^?#]+\.(?:jpg|jpeg|png|webp)$/iu.test(image);
export const isSourcePlaceholder = (image: string) => image === '/akros/products/image-unavailable.svg';
/** Source corporate marketing artwork is not a neutral product photograph, even without literal brand text. */
export const isMarketingCatalogImage = (image: string) => /(?:banner|sekce)/iu.test(image);
export const isBrandedCatalogImage = (image: string) => /akros/iu.test(image);

/** Fresh demo deliberately starts without source-host URLs. The governed media operator populates photos later.
 * Real-AKROS callers must keep calling buildAkrosEncodedFrom; this is never a global source transformation.
 */
export const pseudonymizeDemoCatalog = (state: AkrosEncodedState): AkrosEncodedState => ({
  ...state,
  categories: state.categories?.map((category) => ({
    ...category,
    description: neutralCatalogText(category.description),
    heading: neutralCatalogText(category.heading),
    imageAlt: neutralCatalogText(category.imageAlt),
    imageSrc: '',
    longDescription: neutralCatalogText(category.longDescription),
    name: neutralCatalogText(category.name),
  })),
  movements: state.movements.map((movement) => ({ ...movement, note: neutralCatalogText(movement.note ?? '') })),
  orders: state.orders.map((order) => ({
    ...order,
    clientRequestId: order.clientRequestId?.replaceAll(/akros/giu, 'sroubshop'),
    contact:
      order.contact === undefined
        ? undefined
        : { ...order.contact, email: order.contact.email.replaceAll(/akros/giu, 'sroubarna') },
    history: order.history?.map((entry) => ({
      ...entry,
      actorLabel: entry.actorLabel === undefined ? undefined : neutralCatalogText(entry.actorLabel),
    })),
    shipping:
      order.shipping === undefined ? undefined : { ...order.shipping, label: neutralCatalogText(order.shipping.label) },
  })),
  products: state.products.map((product) => ({
    ...product,
    category: neutralCatalogText(product.category),
    description: neutralCatalogText(product.description ?? ''),
    imageAlt: neutralCatalogText(product.imageAlt ?? product.name),
    images: [],
    imageSrc: '',
    name: neutralCatalogText(product.name),
    parameters: product.parameters?.map((parameter) => ({
      label: neutralCatalogText(parameter.label),
      unit: neutralCatalogText(parameter.unit),
      value: neutralCatalogText(parameter.value),
    })),
    shortDescription: neutralCatalogText(product.shortDescription ?? ''),
    variants: product.variants?.map((variant) => ({
      ...variant,
      attributes: neutralCatalogText(variant.attributes),
      imageSrc: '',
      name: neutralCatalogText(variant.name),
      parameters: variant.parameters?.map((parameter) => ({
        label: neutralCatalogText(parameter.label),
        unit: neutralCatalogText(parameter.unit),
        value: neutralCatalogText(parameter.value),
      })),
    })),
  })),
});
export const buildSroubshopEncodedFrom = (source: AkrosSource, demoId: DemoId) =>
  buildAkrosEncodedFrom(source, demoId).pipe(Effect.map(pseudonymizeDemoCatalog));
