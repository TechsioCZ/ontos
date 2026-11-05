// How the N1 demo products are named and labelled on the storefront. The N1 import keeps the source size code as
// "Source option <size>" and the colour as the SKU's last segment; this module turns both into shopper-facing labels.

/**
 * Colour names from N1's own catalogue or the legacy source: BLK is Black (N1's public product code
 * 38SA075404-BLK2 lists "Black"), SLB is Slate Blue (the legacy BARVA of ...-SLB), CBT is Cobalt (Spyder's product names).
 */
export const VERIFIED_COLOUR_NAMES: Readonly<Record<string, string>> = {
  BLK: 'černá',
  CBT: 'kobaltová',
  SLB: 'břidlicově modrá',
};

/**
 * Colour names read from the product photos, because N1 has not supplied its official colour names yet. They are
 * placeholders: swap them for N1's names when they arrive (the SKU code stays the key).
 * `PHOTO_COLOUR_NAMES` applies to the colour code; `PHOTO_COLOUR_NAMES_BY_FULL_CODE` applies to a code with a digit,
 * where the photo differs from the plain code (BLK1 is red-black, BLK3 is dark navy).
 */
export const PHOTO_COLOUR_NAMES: Readonly<Record<string, string>> = {
  ACI2: 'starorůžová',
  CNA: 'světle šedomodrá',
  LMB: 'tmavě šedá',
  MMP: 'vícebarevná',
  PLM: 'vínová',
  SDN: 'béžová',
  SPR: 'červená',
  STM: 'šedá',
  VTB: 'černá s potiskem',
  WHT: 'bílá',
};
export const PHOTO_COLOUR_NAMES_BY_FULL_CODE: Readonly<Record<string, string>> = {
  BLK1: 'červeno-černá',
  BLK3: 'tmavě modrá',
};

/** The colour code of a demo SKU: `38SA075404-BLK2` → { full: 'BLK2', code: 'BLK' }; `38SD125415-ACI2` → code 'ACI'. */
export const colourOf = (sku: string): { readonly full: string; readonly code: string } | undefined => {
  const full = sku.split('-').at(-1) ?? '';
  const match = /^([A-Z]+)\d*$/u.exec(full);
  return match === undefined ? undefined : { code: match[1] ?? '', full };
};

/** Shopper-facing colour name, or undefined when the SKU carries no colour. */
export const colourNameOf = (sku: string): string | undefined => {
  const colour = colourOf(sku);
  if (colour === undefined) return undefined;
  return (
    PHOTO_COLOUR_NAMES_BY_FULL_CODE[colour.full] ??
    VERIFIED_COLOUR_NAMES[colour.code] ??
    PHOTO_COLOUR_NAMES[colour.full] ??
    PHOTO_COLOUR_NAMES[colour.code]
  );
};

/** Product title: the model name, plus the colour whenever the SKU carries one. */
export const productTitle = (name: string, sku: string): string => {
  const colour = colourNameOf(sku);
  return colour === undefined ? name : `${name} – ${colour}`;
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
