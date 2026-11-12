# Merchandise

Catalog, stock, orders and storefront reads of a selling company.

## VAT

- A product names its VAT classification (`cz.vat.standard`, `cz.vat.reduced`); Tax (`commerce.tax`) holds the rates
  and the company's VAT regime.
- Merchandise keeps one materialised copy of the company's rates on its catalog head (`catalog_heads.tax_rates`).
  Storefront reads use only that copy and never call Tax. Staff reads and writes sync it from Tax by themselves; a
  storefront order reads Tax fresh.
- The classification migration seeded every company's copy from the rates its products were stored with (standard
  21 %, reduced 12 %, BOOK-IT held at its 10 %), marked as not yet confirmed by Tax. Until Tax first prices the
  company (a non-payer, or a payer with a rate for every classification), that copy keeps selling exactly as before.
  From then on Tax's answer rules: a missing rule or a refusal leaves goods unsellable, never invented; while Tax is
  unreachable its last answer keeps serving.
- The stored gross price is the price (first tier, else the stored gross). It is never recomputed; only a product
  priced while its classification had no rate gets its first gross when a rate arrives.

Open product decision, for the move of prices to the pricing module: when Tax changes a rate later, storefront
prices (gross is the master) stay as they are and only the VAT inside them changes. Staff orders, priced from the net
price, change their totals with the new rate.
