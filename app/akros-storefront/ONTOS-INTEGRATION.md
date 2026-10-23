# AKROS × OntOS (standalone)

Kai's Next.js app stays an independent channel inside the `app/` pnpm workspace: one shared
lockfile and published UI-kit catalog, no federation, no OntOS vertical and no redesign.
The storefront always reads OntOS; there is no local prototype data source. The pure catalog model lives in `src/ontos/catalog-model.ts`; server
pages bind it to bounded owner reads, client navigation uses `CatalogProvider`. All integration code
lives under `src/ontos` and Next route handlers.

## Local startup

```sh
pnpm install --frozen-lockfile
# Local OntOS demo; reads ../.env.demo.local on the SERVER only:
node scripts/with-demo-env.mjs build
node scripts/with-demo-env.mjs start # 127.0.0.1:3070
```

Never use `NEXT_PUBLIC_` for a credential.

Server environment:

| Variable                                   | Meaning                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `ONTOS_AKROS_STOREFRONT_API_KEY`           | Required; dedicated least-privilege service key                    |
| `ONTOS_SHELL_URL`                          | Shell gateway origin, default `http://localhost:3020`              |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL` | Default `http://127.0.0.1:3041/active`                             |
| `ONTOS_COMPOSITION_REVISION`               | Optional fallback if publisher unavailable                         |
| `STOREFRONT_IMAGE_HOSTS`                   | Optional comma-separated extra https image hosts (build AND start) |

A commented template is in `.env.example`.

## Production deploy

```sh
pnpm install --frozen-lockfile
export ONTOS_AKROS_STOREFRONT_API_KEY=… \
  ONTOS_SHELL_URL=https://… ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL=https://…/active
pnpm run build
pnpm run check:browser-bundle       # fails if the key appears anywhere in .next/static
pnpm start -p 3070 -H 0.0.0.0
```

All variables are read by the Node server at runtime (`getConfig()`); none is inlined
into the browser bundle. `STOREFRONT_IMAGE_HOSTS` is also read by `next.config.ts`, so set it for
both build and start. Any Node 22+ host that can run `next start` works; no OntOS code is bundled.

Legal entity is pinned to `71000000-0000-4000-8000-000000000024` (AKROS demo), not supplied by a browser.

The shared demo runs committed code in `ontos-runtime`:
`app/scripts/demo/rebuild-one.sh akros-storefront`. This fast-forwards the runtime then runs only
the workspace's frozen pnpm install and this app's build/start. PID: `app/.scratch/demo-pids/akros-storefront.pid`;
logs: `app/.scratch/demo-logs/{build-akros-storefront,akros-storefront}.log`.
`up.sh` includes the helper; `down.sh` already stops every registered process group.

## OntOS identities

| Identity        | Value in the demo                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant          | Demo tenant `70000000-0000-4000-8000-000000000020` (shared by all demo companies; data is separated per Legal Entity).                                                                                                                                     |
| Legal Entity    | AKROS `71000000-0000-4000-8000-000000000024` (`ONTOS_AKROS_STOREFRONT_LEGAL_ENTITY_ID`). Every read/action carries it; Core rejects other companies.                                                                                                       |
| Storefront      | Service principal `akros-storefront` (`35de81d2-adc3-5ca7-bcbb-319267a218ce`, `ONTOS_AKROS_STOREFRONT_PRINCIPAL_ID`, role `storefront`) with its own API key held only by this BFF. Staff links open it at `storefrontOrigin` `http://localhost:3070`.     |
| Channel         | `STOREFRONT`: every order the BFF places is stored by merchandise with `channel: "STOREFRONT"`, author „Zákazník – e-shop (DEMO)“ and `demo: true`. Staff-created orders use `channel: "STAFF"`.                                                           |
| Commerce Market | Not a separate `commerce.market-catalog` record in this demo. The AKROS merchandise aggregate is the one market: Czech Republic, CZK, gross prices with 21 % VAT, Czech copy. A non-CZK owner price is shown as „cena není dostupná“ and cannot be bought. |

## Safety and data model

`config`, `gateway`, `catalog-server`, `quote`, `http`, and every API route import `server-only`.
Only these server modules read the key. No direct vertical/backend URL or bearer token is
serialized to the browser. Gateway implementation follows `apps/eshop-storefront/server/ontos.ts`:
fresh single-use assertion per read/action, fixed merchandise audience and AKROS legal entity,
composition refresh, 4–6 second timeouts, at most three attempts for reads with backoff.
Product reads are cached per query for 10 seconds (`CATALOG_CACHE_MS`, at most 100 queries), the
navigation tree for 60 seconds (`CATEGORY_CACHE_MS`, at most 20 detailed categories); checkout,
quote and order-revision reads are always fresh.

Catalog source: EVERYTHING the customer sees comes from OntOS. No page, provider or route reads
Kai's generated JSON (it is only the OntOS seed input). `src/ontos/catalog-server.ts` sends
merchandise `records` with `{view:{storefront:true,storefrontCatalog:{…}}}`. Product reads always
send `includeCategories:false`; listings read `fields:"card"`, only product detail reads `"full"`.
The navigation tree is a separate cached read merged into the model (`createCatalog`):

| Page / caller                                           | `storefrontCatalog`                                                                       | Size (AKROS) |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ |
| Navigation tree (layout sidebar, trails, header search) | `{pageSize:1,fields:"card",includeCategories:true}` (60 s)                                | ≈ 230 kB     |
| Category content (`/kategorie/[slug]` heading, grid)    | `{pageSize:1,fields:"card",includeCategories:true,categorySlug}` (60 s)                   | ≈ 230 kB     |
| Homepage, cart/product recommendations, favourites      | `{featured:true,pageSize:20,fields:"card"}`                                               | ≈ 26 kB      |
| `/kategorie/[slug]`                                     | `{categorySlug,page,pageSize:24,sort,q?,minMinor?,maxMinor?,availability?,fields:"card"}` | ≈ 30 kB      |
| `/vyhledavani`                                          | `{q,page,pageSize:24,fields:"card"}`                                                      | ≈ 30 kB      |
| Header suggestions `POST /api/ontos/search`             | `{q,page:1,pageSize:6,fields:"card"}` + cached tree                                       | ≈ 8 kB       |
| `/novinky-a-akce`                                       | `{label:"new"\|"action"\|"sale",pageSize:48,fields:"card"}`                               | ≈ 60 kB      |
| `/produkt/[slug]`                                       | `{slug,pageSize:1,fields:"full"}`                                                         | ≤ 210 kB     |
| Cart quote / checkout                                   | `{productIds,variantIds,pageSize:n,fields:"full"}` fresh (only the cart's variants)       | small        |
| Order revision                                          | `{pageSize:1,fields:"card"}` fresh                                                        | ≈ 2 kB       |

Every product response carries `total`, `page`, `pageSize`, `revision` and
`homepageFeaturedProductIds`; every product carries the owner's `variantSummary`
(`count`, `minGrossPriceMinor`, `stockOnHand`, `units`), which listing cards use for „od“ prices,
„Vybrat variantu“ and stock. `catalog-projection.ts` maps only owner fields: names, slugs, SKUs,
`description` (authoritative; split on blank lines into detail paragraphs), gallery/images,
parameters, labels (`flags`), prices/tiers, stock and minimums. Unknown/new owner products are
offered; unpublished or inactive ones never are. A missing, zero or non-CZK owner price is shown as
**cena není dostupná** with its reason and an inactive buy button; owner availability `UNKNOWN`,
untracked stock (`stockTracked:false`) or a missing availability is shown as **dostupnost nyní nelze
ověřit** and is never sold (the raw `stockOnHand` alone never means „skladem“). Images that `next/image` cannot serve (non-https or a host outside
`www.akros.cz/data/**` + `STOREFRONT_IMAGE_HOSTS`) become the honest "image unavailable" placeholder.
Navigation payload: the browser never receives the whole category tree or product data from the
layout. The root layout ships only Kai's curated sidebar sections (2 roots + their listed children,
id/parentId/slug/name/position/image only) and no products. Category and product pages add their
active branch (trail + children of each trail level) through `CategoryBranch`
(`src/ontos/category-branch.tsx`). Header suggestions get category matches from
`POST /api/ontos/search` (`categories: [{id,slug,name,trail}]`). This keeps `/` at roughly 0.2 MB of
HTML instead of about 1.9 MB. Search results and header suggestions are cards: a variant group links
to its detail page with `?variant=<query>`, which pre-filters the variant table when a variant matches.
Kai's placeholder group named "AKCE" stays in search results and totals
but is listed after real goods (search page and header suggestions).
Kai's homepage banner carousel and content pages are static marketing content, not catalog data.
The sidebar keeps Kai's curated section order by category slug; renamed categories update live,
a category whose slug changes in OntOS drops out of that curated sidebar but stays reachable.
Outage shows a Czech error, never prototype stock. Header search shows a failed OntOS search as an
error with **Zkusit znovu**, never as „0 produktů“; pages use the error boundary with a retry button.

Cart remains Kai's browser-local named cart storage, labelled **Demonstrační košík – nejde o skutečný
nákup**. `POST /api/ontos/cart` (`{cart, deliveryId?}`) revalidates fresh owner prices, applicable
quantity tiers, availability, stock, minimum and package multiples, then asks OntOS itself to validate
the same lines without saving (`PlaceStorefrontOrder` with `dryRun:true`). The response is
`{cart, priceChanged, issues, lineIssues[{productId,variantId,code,message}], canCheckout, totals}`;
`totals` (`totalMinor`, `totalVatMinor`, `netMinor`, `shippingMinor`) are the owner's dry-run totals,
so the browser never computes VAT. A blocked line names product and variant and shows its state
instead of „Skladem“; every continue/confirm action stays disabled (with the reason) until the quote
succeeds. A failed quote shows an error with **Zkusit znovu**. Price changes
require the visible **Přijmout nové ceny** action; they are never silently accepted.
Before consent, the quote lists old → new gross unit prices, each changed line total and the
cart merchandise subtotal. The cart itself keeps its original amounts until the customer accepts.

Mandatory package quantities are selling constraints, not an optional discount.
`purchase-constraints.ts` rounds the owner minimum up to a complete package and publishes an
additive `quantityStep` for purchase controls, cart edits and browser storage. Both purchase
buttons therefore add only legal package multiples (including metre-based products). The UI
explains this before adding; grouped product summaries defer to each variant rather than
advertising another variant’s minimum. The server still rechecks all constraints independently.

`POST /api/ontos/orders` only constructs `PlaceStorefrontOrder`, through merchandise
`apply-command`. It validates the input and delivery details, uses the fresh aggregate revision
and an idempotency key derived from the persisted `clientRequestId` + exact payload. The owner
rechecks prices/stock/quantities and persists/deduplicates the order by clientRequestId. It never
accepts a browser-requested arbitrary Action. Origin/content-type/body-size checks protect the BFF.
BFF status codes: cross-origin 403, non-JSON content type 415, oversized body 413, malformed JSON or
invalid cart/delivery data 400; only a real OntOS failure is 503, with a
route-specific Czech message (cart, order status, search). The summary button locks on the first
click (ref, not state), so a fast double/triple click sends one order request.

The browser persists the pending request ID before sending, then stores the real order number,
owner order id, request id and owner totals in Kai's order snapshot. Confirmation survives refresh
in the same tab/session.

Live order status: the confirmation page polls `POST /api/ontos/order-status` with
`{orderId, clientRequestId}` every 10 seconds (and on window focus) and stops at **Dokončená** or
**Stornovaná**. The BFF reads `{view:{storefront:true,storefrontOrderStatus:{orderId,clientRequestId}}}`
and returns only `{id,number,status,statusLabel,updatedAt,final}` with the staff workflow's Czech
labels (Nová, Zpracovává se, Připravená k předání, Předáno dopravci (simulace), Dokončená,
Stornovaná). Both ids must match, so the endpoint cannot enumerate orders. No staff orders read,
customer data or order-search endpoint is exposed to the public browser.

## Honest demo boundaries

**DEMO – objednávky se jen ukládají pro ukázku; nic neplatíte a nic vám nedoručíme.** Orders are
real in OntOS and order e-mails are really sent (local Mailpit inbox `http://localhost:8025`, order
confirmation and every status change, receipts on the confirmation page). Carriers, payment,
account/login and parcel tracking are simulated. The top banner labels this on every live page.
Checkout offers owner-supported personal pickup (0 Kč) or Zásilkovna (79 Kč) and only the inactive
**Nic neplatíte (DEMO)** payment. Orders use the Czech staff note **Platba se neprovádí (DEMO).**
The CTA is **Potvrdit DEMO objednávku** with the exact notice before and after confirmation:
**E-shop je prezentační demo. Žádné zboží vám nebude doručeno a nic neplatíte.**
HTTP errors (including non-JSON), invalid success payloads and network failures show Czech retry
guidance without clearing the cart or inventing a local success. The same persisted submission ID
is reused on retry, including after an ambiguous response; only validated owner order numbers and
totals produce confirmation.

Category lists combine name/SKU text, unit/from price range (CZK with VAT), availability
and sorting (Czech name A–Z by default, price ascending/descending). Filters apply server-side to
the current permitted catalog, not to the current page only. GET query keys `q`, `min`, `max`,
`availability=in-stock|out-of-stock`, `sort=name|price-asc|price-desc` survive reload/back and
pagination. Filter submit resets pagination; **Vymazat filtry** clears the complete selection.
A grouped product uses its displayed lowest/from price and the owner's availability of its variants.
No query parameter changes backend authorization or company.

The storefront is nonproduction: all pages inherit robots `noindex, nofollow`, every response has
`X-Robots-Tag: noindex, nofollow, noarchive`, and `/robots.txt` disallows all crawlers. This is
indexing guidance, not authentication or access control.

Staff: `eshop@akros.demo`, `http://localhost:3020/cs/provoz/produkty` (AKROS company).
Edit a product name, description, image, label, category or variant net price, save, wait at most
10 seconds, reload the storefront. An existing cart
shows a price-change acceptance state; new additions use the fresh price. Orders appear in
`http://localhost:3020/cs/prodej/objednavky`; moving an order through the workflow there updates
the open confirmation page within 10 seconds.

## Screen matrix

Result column: unit/component tests in `tests/` (vitest) plus the live headless check on
2026-10-21 (screenshots in `techsio-demo/v2/shots/reqfix-akros-storefront/`).

| Screen                        | Data shown                                                       | Read / Action                                                                               | Typed owner response                                                                         | Error states                                                                                                                             | Test result                                                      |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Home `/`                      | featured products, curated sidebar                               | read `records` `{featured:true,pageSize:20}`                                                | `ProductRecord[]` + categories, `revision`                                                   | OntOS down → error page + „Zkusit znovu“                                                                                                 | PASS (catalog tests, live)                                       |
| Category `/kategorie/[slug]`  | cards, filters, pagination                                       | read `{categorySlug,page,pageSize:24,sort,q,min,max,availability}`                          | page of `ProductRecord` + `total`                                                            | unknown slug 404; outage → error page; empty filter → „Nic nenalezeno“                                                                   | PASS (category filter tests, live)                               |
| Search `/vyhledavani`, header | results, suggestions                                             | read `{q,page,pageSize}`; `POST /api/ontos/search`                                          | page of `ProductRecord` + `categories[{id,slug,name,trail}]`                                 | header: error + „Zkusit znovu“ (never 0 results); page: error boundary                                                                   | PASS (search route test, live fault injection)                   |
| Product `/produkt/[slug]`     | gallery, texts, parameters, variants, tiers, price, availability | read `{slug,pageSize:1}`                                                                    | `ProductRecord` with `variantRecords[{availability,grossPriceMinor,priceTiers,stockOnHand}]` | 404; „cena není dostupná“ + reason, buy disabled; „dostupnost nyní nelze ověřit“, buy disabled                                           | PASS (projection tests, live product-34459 zero price / UNKNOWN) |
| Cart `/kosik`                 | lines, line state, demo label, verification                      | `POST /api/ontos/cart` → fresh read `{productIds}` + action `PlaceStorefrontOrder` `dryRun` | `StorefrontOrderResult` `VALID`/`REJECTED` with `issues[{code,message,productId,variantId}]` | price change → accept; blocked line (UNKNOWN, no price, stock, minimum, package) → named reason, continue disabled; 503 → „Zkusit znovu“ | PASS (quote + cart component tests, live)                        |
| Delivery / address steps      | methods, contact (fictitious prefill), summary with owner VAT    | same cart quote with `deliveryId`                                                           | dry-run `totalMinor`, `totalVatMinor`, `shippingPriceMinor`                                  | quote blocked/failed → continue disabled with reason                                                                                     | PASS (live)                                                      |
| Review `/kosik/shrnuti`       | lines, totals, exact demo notice                                 | action `PlaceStorefrontOrder` (`POST /api/ontos/orders`)                                    | `StorefrontOrderResult` `PLACED`/`REPLAYED` (number, id, totals) or `REJECTED` 409           | 409 owner issues shown; 503 → retry with the same `clientRequestId`; confirm disabled while the quote is blocked                         | PASS (order route test, live)                                    |
| Confirmation                  | order number, live status, e-mail receipts                       | read `storefrontOrderStatus`; dispatcher receipts                                           | `{id,number,status,statusLabel,updatedAt,final}`                                             | 404/400/503 → Czech message, polling continues                                                                                           | PASS (order-status tests, live)                                  |

## OntOS owner side (merchandise, two-way)

OntOS is the source of truth for everything the storefront shows: product and variant names, short and long
description (`description`, paragraphs separated by a blank line; `descriptionParagraphs` is derived), gallery
(`images`, exposed as `gallery`), main image `imageSrc`/`imageAlt`, category tree (`categories`: id, parentId, name,
slug, heading, description, longDescription, position, imageSrc, imageAlt, hasChildren), parameters, labels
(`isAction` akce, `isNew` novinka, `isRecommended` doporučujeme, `isSale` výprodej, on products and variants), units,
minimum and package quantities, price tiers, gross prices and stock. Kai's generated JSON is only the seed input.

### Catalog read

```json
{
  "view": {
    "storefront": true,
    "storefrontCatalog": {
      "page": 1,
      "pageSize": 24,
      "categorySlug": "kava",
      "q": "espresso",
      "label": "recommended",
      "availability": "in-stock",
      "sort": "price-asc",
      "minMinor": 10000,
      "maxMinor": 50000,
      "fields": "card",
      "includeCategories": false
    }
  }
}
```

- Filters: `slug`, `categorySlug`, `q`, `featured`, `label` (`action|recommended|sale|new`), `productIds` (up to 200),
  `variantIds` (up to 200; with `full`, each product's `variantRecords` hold only these variants),
  `minMinor`/`maxMinor`, `availability` (`in-stock|out-of-stock`), `sort` (`name|price-asc|price-desc`).
  `pageSize` is 1 to 250, default 24. `fields` is `card` or `full` (default `full`); `card` omits `variantRecords`,
  `description`, `descriptionParagraphs` and `parameters`. `full` pages hold at most 2 products (50 with `variantIds`).
- Response: `{ products, total, page, pageSize, categories?, homepageFeaturedProductIds, revision }`.
- `featured` returns `homepageFeaturedProductIds` order first, then `isRecommended` products.
- `in-stock` means IN_STOCK or LOW_STOCK. `out-of-stock` is everything else (OUT_OF_STOCK, UNKNOWN).
- Price filters compare the gross `grossPriceMinor`.
- `q` ignores case and diacritics (`sroub` finds `šroub`). Every word must occur in the name,
  SKU, short description, parameters, or a variant's name, SKU, attributes or parameters, in any order.
- `categories` (unless `includeCategories:false`) is the navigation tree: id, parentId, name, slug, position,
  hasChildren, published. `description`, `imageSrc` and `imageAlt` are present only for root categories, the
  `categorySlug` category and its direct children; `heading` and `longDescription` only for the `categorySlug` category.
- Without `storefrontCatalog`, the legacy `{ "storefront": true }` read returns the whole published catalog
  (about 13 MB for AKROS). Do not use it.

### Order status

```json
{
  "view": {
    "storefront": true,
    "storefrontOrderStatus": { "orderId": "…", "clientRequestId": "…" }
  }
}
```

Response: `orderStatus: { id, number, status, statusLabel, updatedAt } | null` and `products: []`. Both `orderId` and
`clientRequestId` must match, so the lookup cannot enumerate orders. No contact, address, lines or totals are ever
returned.

| Status    | Czech label                 |
| --------- | --------------------------- |
| NEW       | Nová                        |
| CONFIRMED | Zpracovává se               |
| PACKING   | Připravená k předání        |
| SHIPPED   | Předáno dopravci (simulace) |
| DELIVERED | Dokončená                   |
| CANCELLED | Stornovaná                  |

### Order placement and stock

- `PlaceStorefrontOrder` re-validates price and tier, stock, minimum and package multiples on the server.
  A mismatch returns outcome `REJECTED` with readable issues and saves nothing.
- Insufficient stock returns `REJECTED` with issue `INSUFFICIENT_STOCK` and `availableQuantity`.
- A `PLACED` order writes one negative ORDER stock movement per line, in the same optimistic-revision save as the
  order. Reference is the order number, note `Objednávka <číslo> z e-shopu`.
- A concurrent order that loses the revision race retries up to twice against the newer state.
- Cancelling (`ChangeOrderStatus` to CANCELLED) writes the compensating positive ORDER movement per line.
  Removing an open DEMO order does the same.
- Replays with the same `clientRequestId` return outcome `REPLAYED` and never move stock twice.
- Success and replay results carry `orderId` and `orderNumber`.

```diff
  PlaceStorefrontOrder (revision N)
    order      NEW  +1 line set
  + ORDER movement  -2  ref=<number>  "Objednávka <number> z e-shopu"   (same save)
  Cancel
  + ORDER movement  +2  compensating
```

### Staff side

- Product detail tab „Obsah e-shopu“: category from the tree, parameters, labels, alt text and the history
  „Historie změn obsahu“.
- Name and descriptions are on „Detail“. Images are on „E-shop a obrázky“.
- „Kategorie e-shopu“ on the product list edits name, heading, descriptions and order. This is `UpdateCategory`,
  administrator only, audited. The list uses the storefront order (position, then Czech name). The seed numbers
  Kai's unordered siblings 10, 20, 30… by name, so the storefront order stays the same and a category can be
  moved first („Na začátek“), last („Na konec“) or between two others.
- The product slug must be unique. `UpdateProduct`/`CreateProduct` with a slug another product uses is refused
  (409), and the editor says „Adresu produktu už používá jiný produkt“.
- On a product with variants every manual stock movement („Pohyby“ or „Varianty a ceny“) names the variant; a
  product-level movement is refused (409), because the storefront sells variant stock. „Pohyby“ shows the variant
  of each row.
- The service key may only place storefront orders and read the storefront views.

### Performance

The owner caches the decoded aggregate per revision. Storefront reads are paged and filtered server-side.
Target: under 300 ms per warm read.

### Seed

```bash
cd app && mise exec -- pnpm demo:seed:akros                 # import, idempotent
cd app && mise exec -- pnpm demo:seed:akros --validate-only  # check without writing
cd app && mise exec -- pnpm demo:seed:akros --restore-catalog # reset seed products only
```

- Full catalog: 1 289 groups, 19 025 explicit variants plus single-item groups, 20 304 sellable units, 2 125 categories.
- Existing products, prices, stock, live orders and the 6 sample orders are kept.
- Kai's copy promises quantity discounts („Limity množstevních slev … Snížená cena se projeví po vložení zboží do
  košíku“) in 1 018 texts, but his data has one price tier per item. OntOS cannot honour them, so the import (and a
  re-run on existing data) removes that sentence. Real tiers can be added later as `priceTiers`.
- A second run prints `already seeded … nothing changed`.

### Environment

Unchanged: `ONTOS_AKROS_STOREFRONT_API_KEY`, `ONTOS_SHELL_URL`,
`ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL`, optional `ONTOS_COMPOSITION_REVISION`. The legal entity is pinned to
`71000000-0000-4000-8000-000000000024`.
