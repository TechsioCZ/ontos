// Remove only the feed's known introductory notice, never an entire mixed paragraph.
const quantityPricingNotice =
  /^Limity množstevních slev:\s*nižší cena od \d+ kusů\s+další snížení ceny od \d+ kusů\s+Snížená cena se projeví po vložení zboží do košíku(?:\.(?=\s|$))?\s*/i;

export function getProductDescriptionParagraphs(paragraphs: readonly string[]): string[] {
  return paragraphs
    .map((paragraph) => paragraph.trim().replace(quantityPricingNotice, "").trim())
    .filter(Boolean);
}
