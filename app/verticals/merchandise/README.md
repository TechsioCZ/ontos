# Merchandise

Catalog, stock, orders and storefront reads of a selling company.

## VAT

- A product names its VAT classification (`cz.vat.standard`, `cz.vat.reduced`); Tax (`commerce.tax`) holds the rates
  and the company's VAT regime.
- Merchandise keeps one materialised copy of the company's rates on its catalog head (`catalog_heads.tax_rates`),
  with the time Tax last confirmed it. Storefront reads use only that copy and never call Tax. Staff reads also answer
  from it (showing when Tax confirmed it) and never wait for Tax: when Tax's answer is older than 12 minutes they start
  one refresh per company in the background, and a later read or write materialises the new answer. Rates change by
  declaration and scheduled changes are already in the dated periods, so the rate at any instant stays exact.
- A write that prices something new (a new order or order line, a new product price) waits up to 3 seconds for that
  refresh. If Tax does not answer, it uses the copy only while it is either the migrated one (see below) or confirmed
  by Tax within the last 24 hours; otherwise it is refused with a clear reason. An order edit that keeps its existing
  lines never needs Tax.
- The classification migration seeded every company's copy from the rates its products were stored with (standard
  21 %, reduced 12 %, BOOK-IT held at its 10 %), marked as not yet confirmed by Tax. Until Tax first prices the
  company (a non-payer, or a payer with a rate for every classification), that copy keeps selling exactly as before.
  From then on Tax's answer rules: a missing rule or a refusal leaves goods unsellable, never invented.
- The stored gross price is the price (first tier, else the stored gross). It is never recomputed; only a product
  priced while its classification had no rate gets its first gross when a rate arrives.

Open product decision, for the move of prices to the pricing module: when Tax changes a rate later, storefront
prices (gross is the master) stay as they are and only the VAT inside them changes. Staff orders, priced from the net
price, change their totals with the new rate.
