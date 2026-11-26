// Whether a product is on its company's e-shop, and why not, from the facts the storefront read itself filters on
// (merchandise-queries.ts storefrontFilters, sellableClassificationFilter, marketOfferPredicate and
// mainSourceListingFilter, evaluated by the same SQL for each staff row), worded for staff in Czech.
import { Schema } from 'effect';

export const StorefrontVisibilitySchema = Schema.Struct({
  active: Schema.Boolean,
  /** Variants that are active (the product page shows only those). */
  activeVariants: Schema.Int,
  archived: Schema.Boolean,
  /** The storefront's product address (origin and `/produkt/<slug>`). */
  href: Schema.optionalKey(Schema.String),
  /** Passes the storefront's „only main products“ listing rule (category listings and search). */
  mainSource: Schema.Boolean,
  /** Each configured market of the company and whether it offers the product. */
  markets: Schema.Array(Schema.Struct({ marketCode: Schema.String, offered: Schema.Boolean })),
  /** A gross price of the product or of an active variant. */
  priced: Schema.Boolean,
  published: Schema.Boolean,
  /** The company can sell the product's VAT classification now (its last sync with Tax). */
  sellable: Schema.Boolean,
  variants: Schema.Int,
});
export type StorefrontVisibility = typeof StorefrontVisibilitySchema.Type;

export interface StorefrontVisibilityReason {
  /** What to change. */
  readonly fix: string;
  /** What hides the product, in plain Czech. */
  readonly why: string;
}

export interface StorefrontVisibilityStatus {
  /** What does not hide it but the shopper sees (no price, a market that does not offer it). */
  readonly notes: readonly string[];
  /** The product page opens by direct link (true also for a product hidden only from listings). */
  readonly pageOpens: boolean;
  readonly reasons: readonly StorefrontVisibilityReason[];
  /** Listed in the e-shop's categories and found by its search. */
  readonly visible: boolean;
}

export const storefrontVisibilityStatus = (facts: StorefrontVisibility): StorefrontVisibilityStatus => {
  const page: StorefrontVisibilityReason[] = [];
  if (facts.archived) {
    page.push({ fix: 'Obnovte produkt z archivu.', why: 'Produkt je archivovaný.' });
  }
  if (!facts.active) {
    page.push({ fix: 'V záložce Detail zapněte „Aktivní produkt“ a uložte.', why: 'Produkt není aktivní.' });
  }
  if (!facts.published) {
    page.push({
      fix: 'V záložce E-shop a obrázky zapněte „Zveřejnit v e-shopu“ a uložte.',
      why: 'Produkt není zveřejněný v e-shopu.',
    });
  }
  if (!facts.sellable) {
    page.push({
      fix: 'V záložce Detail nastavte zařazení pro DPH (základní nebo snížená sazba). Je-li nastavené, firma pro ně musí mít v Daních jednu platnou sazbu.',
      why: 'Zařazení produktu pro DPH chybí nebo ho firma teď nemůže prodávat.',
    });
  }
  const offered = facts.markets.filter((market) => market.offered);
  if (facts.markets.length > 0 && offered.length === 0) {
    page.push({
      fix: 'V záložce Trhy produkt na trhu e-shopu zapněte.',
      why: `Produkt nenabízí žádný trh e-shopu (${facts.markets.map((market) => market.marketCode).join(', ')}).`,
    });
  }
  if (facts.variants > 0 && facts.activeVariants === 0) {
    page.push({
      fix: 'V záložce Varianty a ceny aktivujte aspoň jednu variantu.',
      why: 'Produkt má varianty, ale žádná není aktivní.',
    });
  }
  const listing: StorefrontVisibilityReason[] = facts.mainSource
    ? []
    : [
        {
          fix: 'V záložce E-shop a obrázky zapněte „Zobrazit v seznamech e-shopu jako hlavní produkt“, nebo v Prodej › E-shopy vypněte „Jen hlavní produkty“.',
          why: 'E-shop ve výpisech a ve vyhledávání ukazuje jen hlavní produkty a tento jím není (stránka produktu se otevře jen přímým odkazem).',
        },
      ];
  const notes = [
    ...(facts.priced ? [] : ['Produkt nemá cenu: e-shop u něj ukáže „Cena není dostupná“ a nedá se objednat.']),
    ...(offered.length > 0 && offered.length < facts.markets.length
      ? [
          `Na trhu ${facts.markets
            .filter((market) => !market.offered)
            .map((market) => market.marketCode)
            .join(', ')} se nenabízí.`,
        ]
      : []),
  ];
  return {
    notes,
    pageOpens: page.length === 0,
    reasons: [...page, ...listing],
    visible: page.length === 0 && listing.length === 0,
  };
};
