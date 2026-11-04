// How the N1 demo products are named and labelled on the storefront. The N1 import keeps the source size code as
// "Source option <size>" and the colour as the SKU's last segment; this module turns both into shopper-facing labels.

/**
 * Colour names verified against the source: BLK is Black (N1's public product code 38SA075404-BLK2 lists "Black"),
 * SLB is Slate Blue (the legacy catalogue's BARVA for SKU ...-SLB), CBT is Cobalt (Spyder's own product names).
 * Any other code is shown as its SKU code until N1 supplies the colour name.
 */
export const VERIFIED_COLOUR_NAMES: Readonly<Record<string, string>> = {
  BLK: 'černá',
  CBT: 'kobaltová',
  SLB: 'břidlicově modrá',
};

/** The colour part of a demo SKU: `38SA075404-BLK2` → { code: 'BLK', variant: '2' }. */
export const colourOf = (sku: string): { readonly code: string; readonly variant: string } | undefined => {
  const last = sku.split('-').at(-1) ?? '';
  const match = /^([A-Z]+)(\d?)$/u.exec(last);
  return match === undefined ? undefined : { code: match[1] ?? '', variant: match[2] ?? '' };
};

/** Shopper-facing colour label, or undefined when the SKU carries no colour. */
export const colourLabel = (sku: string): string | undefined => {
  const colour = colourOf(sku);
  if (colour === undefined) return undefined;
  const name = VERIFIED_COLOUR_NAMES[colour.code] ?? colour.code;
  return colour.variant === '' ? name : `${name} ${colour.variant}`;
};

/** Product title: the model name, plus the colour whenever the SKU family carries one. */
export const productTitle = (name: string, sku: string): string => {
  const label = colourLabel(sku);
  return label === undefined ? name : `${name} – ${label}`;
};

/** A variant's shopper-facing label: the size value only, never the source's option wording. */
export const sizeLabel = (sourceOptionValue: string): string => sourceOptionValue.trim();

/** Variant label from the variant's own source parameter ("Source option" = "L/XL"); other variants keep their name. */
export const variantLabelOf = (variant: {
  readonly name: string;
  readonly parameters?: readonly { readonly label: string; readonly value: string }[];
}): string => {
  const option = (variant.parameters ?? []).find((parameter) => parameter.label === 'Source option');
  return option === undefined ? variant.name : sizeLabel(option.value);
};
