# AKROS storefront: e-shop markets (for Kai Uwe)

Your app now serves several markets: `/cs/…`, `/sk/…` and `/en/…` (`/pl/…` exists, but it is suspended).
The change is small and kept apart from your code. No page was redesigned. Routing lives in `src/proxy.ts`, market
resolution in `src/ontos/market*.ts` and `src/ontos/active-market.ts`, and chrome strings in `src/i18n/`. Everything
else is a short touch: a locale-prefixed link, a `money` argument for the currency, or a `marketId` on an OntOS call.
The app is still standalone. It talks JSON to the Shell gateway through `src/ontos/gateway.ts` (`readRecords` / `callAction`).

## Why

AKROS sells in several markets: CZ in CZK, SK and EU in EUR, PL in PLN (prepared, currently suspended). Each market has
its own offer (which products are sold) and its own prices. OntOS owns both:

- `commerce.market-catalog` owns the Markets, their lifecycle and which storefronts they are associated with.
- `demo.merchandise` owns, per market, the offer, the currency and the price conversion.

The storefront only chooses a market from the URL and asks the owners.

## Routing (`src/proxy.ts`, `src/ontos/market-locale.ts`)

- `/{locale}/rest`, where locale is 2–3 lowercase letters and not an existing route (`api`, `faq`), is rewritten to your
  existing route `/rest`. The locale travels in the request header `x-akros-market-locale` and the unprefixed path in
  `x-akros-store-path`; a browser-sent header with either name is overwritten. Your route tree did not move.
- Legacy URLs without a locale get a **308** to `/cs/…`, with the query kept (`/kategorie/x?page=2` → `/cs/kategorie/x?page=2`).
- Not routed: `/api/**`, `/_next/**`, `/commerce-customer-context-api/**`, `/akros/**`, and root files with an extension
  (`robots.txt`, icons, …).
- The credential-query redirect still works and now goes to `/{locale or cs}/prihlaseni` (303, no-store, no-referrer).
- API routes stay unprefixed. The browser sends the market locale from its current path
  (`marketRequestHeaders()`), and the server resolves the market again before using it.
- Every internal link carries the locale: `StoreLink` prefixes hrefs, and client code uses `useStoreHref()`,
  server code `marketHref()` for redirects. The 404 search stays in the current market.

## Market resolution (`src/ontos/market.ts`, server-only, 60 s isolate cache)

1. `commerce-market-catalog` read `current-market-catalog {at}`. The app keeps active associations of storefront
   `akros-storefront` with channel B2C that are effective now and sold by the AKROS legal entity. It picks the market whose
   language subtag of `supportedLocales[0]` equals the path locale. If two markets match, an ACTIVE one wins, then the
   lower code.
2. ~~`resolve-commerce-market`~~ (removed 2026-11-02: that owner read requires a trusted-storefront gateway context,
   which the Shell gateway does not issue to the storefront service key, so every call was 403 and every page 500).
   The market's own definition from step 1 decides now: ACTIVE and inside its validity = live, otherwise
   "Tento trh je dočasně nedostupný". The former mapping was:
   - `MARKET_RESOLVED` → live market `{marketId, marketCode, locale}`.
   - `MARKET_NOT_ACTIVE` (or inconsistent configuration) → "Tento trh je dočasně nedostupný" page.
   - not allowed for this storefront → treated as unknown.
3. merchandise `storefrontCatalog {marketId}` reports the market currency and whether its offer is configured.

The proxy only routes:

- live → your route
- suspended → `/trh-nedostupny`
- unknown → a non-existent path (404)

If an owner is down, the proxy does not report an unknown market. The page then renders your usual catalog error.

**Before any market exists** (`hasMarketData` / `isMarketOwnerNotProvisioned` in `market.ts`), the app behaves as before
the change, only under `/cs`:

- This applies when `current-market-catalog` lists no market sold by AKROS (any lifecycle, retired included) and no
  association of `akros-storefront`. It also applies when the market owner is not available to the storefront yet:
  the module is not active (the gateway rejects the audience, HTTP 400 `GatewayAudienceInvalidProblem`), or the read
  is not granted (403) or not published (404).
- `/cs/…` then serves the whole published catalogue in CZK. Catalog reads, quotes and orders carry no `marketId`,
  and the cart keeps its old unscoped storage key (`akros-demo-cart-v3`). Every other locale is a 404 that offers `/cs`.
- The answer is cached for 60 s like any market data, and a warning is logged.
- As soon as one AKROS market or one storefront association exists, only the owners' markets are served. Retiring every
  market therefore never reopens the unfiltered catalogue.
- An owner outage (503, a timeout or any other error) is never treated as "no markets"; it stays an error.

- **Suspended market**: HTTP **200** with `noindex`. A Next page cannot return 503, so the status stays 200. The page is
  localized ("Tento trh je dočasně nedostupný" / "Tento trh je dočasne nedostupný" / "This market is temporarily
  unavailable") and links to the live markets.
- **Unknown locale** (e.g. `/de` with no market): **404** with links to the live markets.
- **Market without a merchandise offer** (`market.configured === false`): only catalog pages (home, category,
  product, search, news) show "Sortiment pro tento trh zatím není nastaven". Content pages stay readable.

## What changed per area

- **Catalog** (`catalog-server.ts`, `catalog-projection.ts`): every `storefrontCatalog` read sends `marketId`. Product,
  category and tree caches are keyed per market. Prices are already in the market currency, and a product in another
  currency shows "cena není dostupná".
- **Currency** (`src/lib/format.ts`): `Intl.NumberFormat` uses the market currency (CZK, EUR, PLN) and the market
  locale. `useMoney()` gives it to client code and `getMoney()` to server code.
- **Cart and checkout** (`cart-provider.tsx`, `features/checkout/*`, `quote.ts`, `api/ontos/orders/route.ts`):
  - Carts are stored per market (`akros-demo-cart-v3:AKROS-SK`).
  - Quote and order send `marketId`, and merchandise rejects products the market does not offer.
    `NOT_OFFERED_IN_MARKET` shows "Není v nabídce trhu" on the cart line and "Některé zboží není v nabídce tohoto
    trhu…" at checkout. `MARKET_UNAVAILABLE` (the market has no offer configured) shows "Tento trh teď objednávky
    nepřijímá…" (`quote.ts`, `checkout-response.ts`, `cart-items-table.tsx`).
  - Shipping prices come from `checkout-options.ts` for the request's market. An answer for another market is rejected;
    this applies to the order route, the checkout API and the "Doprava a platba" page.
- **Account**: order history and order detail show the order's currency, with CZK for older orders
  (`order-model.ts` `orderMoney`).
- **Chrome i18n** (`src/i18n/{cs,sk,en,index}.ts`): header, footer, catalog, cart, search and market pages. Any other
  locale falls back to English.
- **Header switcher**: "CZ · Kč", "SK · €", "EN · €". It does a full page load, because each market has its own offer and
  carts.
- **SEO**: `<html lang>` follows the market. Catalog pages get hreflang alternates for every live market, and every page
  gets a canonical URL per locale.

New files:

- `src/ontos/{market,market-locale,active-market}.ts`
- `src/ontos/{market-context,market-switcher,market-pages,market-not-configured}.tsx`
- `src/app/trh-nedostupny/page.tsx`
- `src/i18n/{en,sk,index}.ts`
- tests `tests/unit/{market-proxy,market-selection,market-format}.test.ts`, `tests/component/market-links.test.tsx`,
  `tests/support/market-fixture.ts`

Tests cover:

- proxy matrix
- market selection: resolved, not active, unknown, not associated, and no market data yet (empty catalog, owner
  not active or not granted, outage stays an error)
- currency formatting (NBSP-aware)
- per-market cart key
- StoreLink prefixing
- per-market catalog caches
- hreflang paths
- catalog and order route sending `marketId`, and no `marketId` before any market exists

## Permissions

The storefront service principal (`akros-storefront`, role `storefront`) needs **read on `commerce.market-catalog`**
for `current-market-catalog` and `resolve-commerce-market`. The lead granted it in `35ae78193`
(`scripts/demo/permissions.mts`, applied on stage by `scripts/demo/eshop-markets-stage-grants.mts`). Merchandise access is
unchanged.

## Local testing

1. Start the demo as usual (`app/scripts/demo/up.sh`, or `rebuild-one.sh akros-storefront`). The modules
   `commerce.market-catalog` and `commerce.storefront-registry` must be active, with the e-shop market seed applied
   (AKROS-CZ / -SK / -EU / -PL / -CZ-B2B).
2. Open `http://localhost:3070/` → 308 to `/cs`. Then check:
   - `/sk`: prices in €, Slovak chrome, the SK-only products.
   - `/en`: € prices and English chrome.
   - `/pl`: unavailable page.
   - `/de`: 404.
   - `/cs/kosik` vs `/sk/kosik`: separate carts.
3. Checks: `mise exec -- pnpm run typecheck | lint | test | build` in `app/akros-storefront`.

## Limitations

- Checkout, account and content pages (o nás, obchodní podmínky, …) are still Czech; only the chrome is translated.
  Product content is single-language, as stored in OntOS.
- Customer e-mails still format CZK. They are owned by `packages/email-delivery`, which has to read
  `document.market.currency`.
- Markets are path-based only. Domains per market (a host map) can come later.
- Market data is cached for 60 s per server instance, so suspending or activating a market shows within a minute.

## Fixes after the first stage rollout (2026-11-02)

- `src/ontos/market.ts`: market availability now comes from the market catalog alone (see Market resolution, step 2).
- `src/ontos/market-link-button.tsx`: the market buttons on the unavailable/404 page are a tiny client component.
  `LinkButton` from the ui-kit always attaches an `onClick`, and a server component cannot pass a function, so the page
  failed with "Event handlers cannot be passed to Client Component props". The same pattern already exists in your
  server components `src/features/account/account-overview.tsx`, `src/app/novinky-a-akce/page.tsx` and
  `src/app/blog/page.tsx` (not touched by the markets change); those pages log the same error when they render a
  `LinkButton`.
- Product cards (`src/components/product-grid.tsx`) take their remaining fixed Czech strings from the market dictionary:
  stock states (`product.stockStatus`, moved from `productStockLabels` in `src/lib/product-stock.ts`), the product code
  prefix (`product.sku`), „Cena není dostupná“ (`product.priceUnavailable`), „Více variant“ (`product.moreVariants`)
  and „Vybrat variantu“ (`product.chooseVariant`), in `src/i18n/{cs,sk,en}.ts`. The product detail page, the cart and
  the category filters still have Czech literals; they were not part of this change.

## Product detail, cart and category filters speak the market (2026-11-02)

Same mechanism as the product cards in the section above: every sentence comes from
`src/i18n/{cs,sk,en}.ts`, the pages read it with `getDictionary()` (server) or `useDictionary()`
(client) and nothing else in your code changed. Czech output is byte-identical to before; only
`/sk` and `/en` (and any future locale) now get their own words. Three commits: `e90ae5d44`
(filters), `14e0d00e4` (product detail), `a056dc70d` (cart).

### Dictionaries (`src/i18n/{cs,sk,en}.ts`)

- `product.*` grew the detail-page and variant-table copy: facts (package quantity, net weight,
  unit of measure, minimum order, variant count), the stock line (in stock / limited / unknown /
  out of stock, single variant and "x of y variants"), price rows (price, excluding/including VAT,
  no valid price, cannot buy now, availability cannot be confirmed), image alt texts, the
  favourite/share/question actions, the variant filter bar (diameter, length, material, price,
  submit), the variant table headers and per-variant availability, the whole-package notes, the
  empty-filter message and the pagination label.
- `cart.*` grew the cart page: `itemsTitle`, `itemsLabel`, `item`/`availability`/`price` columns,
  `removeItem`/`decrementQuantityOf`/`incrementQuantityOf`/`quantityOf` (aria labels),
  `lineState.*` (in stock, cannot verify, not verified, checking, cannot order), `issue.*` (one
  label per quote issue code, keyed like `code`), `backToShop`, `chooseDelivery`, `servicesNote`,
  `priceCheckNote`.
- `checkout.*` grew the chrome that renders on the cart page: `steps.*` (the four step titles),
  `stepsLabel`, `pricesNotVerified`, `verifyingLogin`, `chooser.*` (guest-order panel),
  `selector.*` (named carts), `summary.*` (totals sidebar), `totalsNote.*`, `unconfirmed.*`,
  `recommendationsTitle`.
- `filters.*` is new: query, price range, availability and sort options, the found-count note, the
  clear/submit buttons and the invalid-range warning, plus `minimum`/`maximum` for the variant
  range inputs.
- Counts inside a sentence are formatted by the dictionary itself (`count()` helper in each file:
  `cs-CZ`, `sk-SK`, `en-GB`), so a Czech page keeps `1 234` and the `product.*` functions take
  numbers, not pre-formatted strings.

### Components touched (no layout or markup changes)

- `src/components/category-filters.tsx`: options and labels from `cs.filters` (the two option arrays
  moved into the component, because they depend on the dictionary).
- `src/app/produkt/[slug]/page.tsx`: facts, stock, price rows, alts, badges, variant-section label;
  `generateMetadata` now falls back to `product.title`; numbers use the market's `money.locale`
  instead of a hard-coded `cs-CZ`.
- `src/components/product-detail-actions.tsx`: question/share/favourite labels (client, `useDictionary`).
- `src/features/cart/product-purchase-form.tsx`: single buy form, variant filter bar, variant table,
  buy buttons and their aria labels. `VariantOrderControl`/`VariantRangeFilter` read the dictionary;
  `variantAvailabilityLabel(cs, variant)` takes it as an argument. Number _formatting_
  (`Intl.NumberFormat("cs-CZ")`, `locale="cs-CZ"` on `NumericInput`) is unchanged — it is not copy.
- `src/features/cart/{cart-content,mini-cart,cart-selector}.tsx`,
  `src/features/checkout/{cart-items-table,cart-services,checkout-layout,checkout-summary,server-totals}.tsx`,
  `src/app/kosik/page.tsx` (title via `generateMetadata`).
- `src/features/checkout/checkout-state.ts`: `checkoutSteps` carries `{ key, href }` instead of
  `{ title, href }`; the title is `cs.checkout.steps[key]`. Only `checkout-layout.tsx` used it.
- `blockedLabels` in `cart-items-table.tsx` is gone; `cs.cart.issue[code]` replaces it (unknown
  codes still fall back to `cart.lineState.blocked`).

### Tests

- `tests/unit/i18n-dictionaries.test.ts`: deep key parity between cs/sk/en, no Czech-only letters
  (`ě ř ů`) in sk/en, no Slovak-only letters (`ľ ô`) in cs, and a fixed list of product/cart/filter
  keys that must differ from Czech in both translations. Template functions are called (numbers
  first, labels second) so Czech hidden inside a function is caught too.
- `tests/component/market-copy.test.tsx`: renders the category filters (sk, en, cs), the cart
  (sk, en), the variant table (sk), the single-variant buy form (en) and the product actions (en),
  and asserts the market's words plus the absence of the Czech ones.
- Suite: 576 → 588 tests, all green; typecheck and oxlint clean for the touched files.

### Still Czech on those pages (unchanged, on purpose)

- Checkout **steps** beyond the cart (`/kosik/dodaci-udaje`, `/kosik/doprava-platba`,
  `/kosik/shrnuti`) keep their Czech form labels and validation messages
  (`checkout-state.ts` errors, address fields).
- The quote's long problem messages (`src/ontos/quote.ts`, server side) and the market/availability
  reasons OntOS itself returns are still Czech text from the API; only the short line label is
  translated. Translating them needs a market-aware quote response.
- Content pages, product names/descriptions and parameters stay as stored in OntOS.

### Follow-up `6165627d6`: the cart's own notices and the starter carts

The stage check on `a056dc70d` found the items table clean, but the cart page still had Czech in
two more places, both fixed the same way:

- **Cart verification notices** (`src/ontos/cart-revalidation.tsx`, `cart.quote.*`): the quote card
  label, the checking/error/blocked notices, the "price changed – accept the new price" panel and
  the four `blockedReason` lines. The provider now reads `useDictionary()`; the retry button, the
  goods-total line and the "verified" line come from the same group.
- **Starter cart names** (`src/features/cart/cart-collection.ts`, `cart.defaultCarts.*`): a new
  shopper got `Výchozí košík` / `Komisní košík` on `/sk` and `/en`. `createCartCollection()` and
  `parseCartCollection()` take an optional `DefaultCartNames` (Czech by default), and
  `cart-provider.tsx` fills it from the dictionary. Stored carts keep their name.

Still Czech on the cart in a _problem_ state, and not fixed here: the long message of a blocked
line comes from `src/ontos/quote.ts` (server side, shared with the order route) and from
`document.owner` issue messages. The short label next to the line is translated; the sentence after
it is not. Those lines need a market-aware quote response, which is a change to the API contract,
not to your pages.

### Stage check (2026-11-02, `6165627d6`)

Anonymous headless check of `/sk` and `/en` on https://ontos-stage-akros.web-revolution.cz
(category with `min/max/sort/availability` filters, product detail with one variant, product detail
with the variant table, cart holding a line): no Czech UI copy on any of the eight pages. The only
`ě ř ů` left in the page text are OntOS category and product names ("Příruby", "Řetězy",
"KOLENA SVAŘOVANÁ") and the one server-side quote sentence listed above.

## Brand configuration (2026-11-02)

One build of your app now serves two shops. The brand is chosen per server instance at request time, from the
server environment. Nothing is decided at build time, and no page was redesigned. Without any new variable your shop
renders exactly as before (AKROS).

### Environment (server only, read per request)

| Variable                           | Default                                | Meaning                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STOREFRONT_BRAND`                 | `akros`                                | `akros` or `sroubshop`. Any other value fails the first request loudly (500 with `STOREFRONT_BRAND="x" is not a storefront brand`); it never falls back to AKROS.        |
| `ONTOS_STOREFRONT_APP_ID`          | `akros-storefront`                     | Storefront Application in `commerce.market-catalog` whose market associations this instance serves (replaces the constant `STOREFRONT_APP_ID` in `src/ontos/market.ts`). |
| `ONTOS_STOREFRONT_LEGAL_ENTITY_ID` | `71000000-0000-4000-8000-000000000024` | Selling Legal Entity: every read/action and the market selection use it (replaces the constant in `src/ontos/config.ts`). Must be a UUID.                                |

`ONTOS_AKROS_STOREFRONT_API_KEY` and `ONTOS_SHELL_URL` are unchanged. Both identities come from `getConfig()`, and
`storefrontMarkets()` / `hasMarketData()` take `{ appId, legalEntityId }`.

### The brand module (`src/brand/`)

- `types.ts`: the `Brand` shape (name, legal name, logo or `null`, contacts, metadata, per-language copy, home
  banners, page content) and the serializable `ClientBrand`.
- `akros.tsx` + `akros-copy.ts`: your AKROS content, moved here unchanged (about page, AKROS CZ výroba page,
  branches, galleries, carousel, blog images, company intro, copyright).
- `sroubshop.tsx`: ŠroubShop of the fictional Šroubárna Vysočina s.r.o. Text wordmark instead of a logo, demo-only
  contacts (`eshop@sroubarna.demo`, no IČO, phone or address), neutral images only, no AKROS CZ výroba.
- `index.ts` (server-only): `getBrand()`, `brandLocale()` and `toClientBrand(brand, locale)`.
- `brand-context.tsx` (client): the root layout wraps the app in `<BrandProvider>`. Client components call
  `useBrand()`; it has no default, so no brand profile is ever bundled for the browser. Test suites get AKROS
  from `tests/setup-match-media.ts` unless they mount their own provider.

### What moved

- Dictionaries `src/i18n/{cs,sk,en}.ts`: the AKROS-only keys moved to `akros-copy.ts`: `header.production`,
  `catalog.production`, `home.companyTitle`, `home.companyIntro`, `footer.copyright`. `catalog.description` was
  unused and is gone. `footer.homeLinkLabel` is now `(store) => "… – domovská stránka"`.
- `src/content/home-carousel.ts` moved into the brands. `HomeCarousel` takes `slides` and `title` props.
- `src/content/editorial.ts`: `faqGroups(inquiryEmail)` and `blogArticles(images)` are functions now. `FaqExplorer`
  takes `faqGroups` as a prop from the server page. The about galleries and branches live in the brands.
- Pages reading the brand: layout (title template, description, favicon), home, `o-nas`, `kontakty` (branch map
  and phone are optional now), `kategorie/akroscz-vyroba` (404 for a brand without it), `obchodni-podminky`,
  `gdpr`, `reklamace`, `partnersky-program`, `prihlaseni`, `faq`, `blog`, `novinky-a-akce`, and the inquiry API
  fallback message. Client components reading it: header (logo or wordmark, production link), footer (logo or
  wordmark, contacts, copyright), catalog sidebar ("Speciální kategorie" only with a production site) and the
  contact form.
- `src/app/icon.svg` became `public/akros/icon.svg` (set through metadata `icons`). ŠroubShop uses
  `public/sroubshop/icon.svg`.
- Error pages: `error.tsx` shows the brand name from the provider. `global-error.tsx` replaces the root layout and
  knows no brand, so it shows a brand-neutral "DEMO". This is the only visible AKROS difference: the title is
  now "Katalog je dočasně nedostupný | DEMO" instead of "… | AKROS DEMO".

### Neutral markup prefix (both brands)

Everything that reaches HTML now uses `sf-` instead of `akros-`:

- classes `akros-*` → `sf-*`
- `data-akros-*` → `data-sf-*`
- CSS custom properties `--akros-*` / `--color-akros-*` / `--container-akros-*` → `sf`
- the font variable `--font-akros` → `--font-sf`
- Tailwind containers and variants `@container/akros-*`, `@max-akros-*` → `sf`
- Iconify sets and utilities `token-icon-akros-*` → `sf`
- the unknown-market rewrite target `/_akros-unknown-market` → `/_unknown-market`

The rename was mechanical (a one-off operator script, not kept in the repo). It covers `src`, the
tests (also `tests/browser/*.mjs`) and the stage readiness probe (`app/scripts/ops/stage-demo-readiness.mjs`).
These kept their names because they never reach HTML: the CSS partial file names (`src/tokens/**/_akros-*.css`), the
icon folders, the localStorage/sessionStorage keys (`akros-demo-cart-v3`, `akros-demo-carts-v1`, `akros-favorite-*`,
`akros-ontos-pending:*`), the request headers (`x-akros-market-locale`, `x-akros-store-path`), and the package/directory
name. (The OntOS request ids were renamed afterwards, see below.)

### Public assets

- Brand-neutral assets both shops use moved to `public/storefront/`: footer phone, e-mail and Heureka icons, the
  checkout flag, the neutral photos (warehouses, welding, railing, powder coating, blog and news images) and a copy
  of the image placeholder (`/storefront/products/image-unavailable.svg`, now `imagePlaceholder` in
  `src/ontos/media-path.ts`).
- AKROS-only assets stay under `public/akros/` (logos, carousel banners, branch photo, certificate, branch maps,
  the contact banner used as a blog image). Only the AKROS brand references them.
- `public/akros/products/*` and `public/akros/categories/*` stay where they are, because product data in OntOS links
  them. The catalog projection serves a stored `/akros/products/image-unavailable.svg` as the neutral placeholder.
- The proxy passes `/storefront/**`, `/sroubshop/**` and `/akros/**` through without a locale.
- Variant images that are `media:<asset>` references of the parent product's gallery are served like the gallery:
  `/obrazky/<product>/<asset>`.

### Adding a brand

1. Add the id to `BRAND_IDS` in `src/brand/types.ts`.
2. Create `src/brand/<id>.tsx` exporting a `Brand`. Use `sroubshop.tsx` as the template: `logo: null` gives the
   wordmark, and `production: null` hides the manufacturing page and links. Add `copy` for `cs`, `sk` and `en`.
3. Register it in `brands` in `src/brand/index.ts`. Put brand-only assets under `public/<id>/` and add `<id>` to
   the pass-through list in `src/proxy.ts`.
4. Extend `tests/component/brand-pages.test.tsx` with the new brand.
5. Deploy the same artifact with `STOREFRONT_BRAND=<id>` (plus that instance's app id, legal entity and API key).

### Rendering stays dynamic

The root layout is `force-dynamic`, so every page renders per request. `next build` prerenders only `/robots.txt`
(brand-free: disallow all). There is no sitemap or manifest. `/_not-found` and `icon` are no longer static.

### Tests and proof

- `tests/unit/brand.test.ts`: default, `sroubshop`, unknown values, and the per-language chrome.
- `tests/unit/storefront-config.test.ts`: app id and legal entity defaults, overrides, invalid values.
- `tests/component/brand-pages.test.tsx`:
  - ŠroubShop: renders the header, sidebar and footer in cs/sk/en/pl, every content page, the metadata, and the
    market gate and error pages. It asserts no `/akros/i` anywhere.
  - AKROS: checks that the logo, contacts, links, metadata and content pages are unchanged.
- Local crawl of the built standalone server for both brands, with a fake Shell
  (a one-off operator crawl script, not kept in the repo):
  - ŠroubShop HTML has no `akros` on any page. The one exception is a direct request for
    `/cs/kategorie/akroscz-vyroba`: its 404 echoes the requested URL in the canonical link and the RSC route
    segments.
  - AKROS renders as before (screenshots in the same folder).

### Still containing "akros" with `STOREFRONT_BRAND=sroubshop` (not HTML)

- The compiled CSS file contains `@techsio/ui-kit` theme tokens (`--*-akros-product-card-*`,
  `[data-theme=akros]`). They come from the UI kit's figma variables. No HTML element uses an akros theme.
- The browser JS contains the storage keys and header names listed above.
- Order and quote request ids that persist in OntOS now use `sf-` for both brands (`sf-<uuid>`,
  `sf-quote-*`, order idempotency key `sf-<request id>-<digest>`; `e5e0c77a8`). OntOS treats them as opaque.
  Orders placed before this change keep their `akros-` ids, and a checkout left half-finished in a browser
  during the deploy has to be submitted again.
- OntOS data is out of this change and comes from the demo tenant: product names and descriptions, photos hosted
  on `www.akros.cz`, and market codes (`AKROS-CZ` appears in the RSC payload as the cart storage scope). Lane P's
  data migration handles them.

## Kai's feat/akros merged onto OntOS (2026-11-02)

All 21 commits of `origin/feat/akros` (97b937f77..f1b74b02a, 2026-10-20 → 10-26) are in demo/sales-crm, ported onto the
OntOS storefront (not a git merge: your `mock-storefront` layer no longer exists here). Commits:
`ba2077152` (variant weights index + your plans), `37a8f61ca` (the frontend: catalog/search, product detail + modal +
favourites, cart weight + Smart Address, account reorder/content, your tokens/styles), `5116b291f` (sk/en chrome for
auth, contacts, account and checkout steps), `6093322e5` (sk/en editorial pages, server messages, last leftovers). Kept: live OntOS data, markets `/cs /sk /en`, cs/sk/en dictionaries (all your
new copy is in `src/i18n/*`, Czech word for word), the OntOS cart quote/order, `STOREFRONT_BRAND` and the `sf-` prefix
(your `akros-*` classes/tokens/data attributes are `sf-*`; CSS partial file names and storage keys kept).
How it was merged: a prefix-normalised 3-way merge per file (one-off operator script, not kept in the repo).

### Wired to OntOS

- Product detail, variant table (all variants, no pagination; live dimension filters + reset), variant detail modal
  (`?variantDetail=<OntOS variant id>`), shared selections (`?variantIds=a,b`), prices only for concrete items
  („Cena dle varianty“ for groups; `priceIsFrom` = more than one variant) — all OntOS reads.
- Variant chooser and favourites list: `GET /api/ontos/product-variants/<slug>` (market-aware `readProducts`), replacing
  your `/api/favorites/catalog/[slug]` that read the static catalog.
- Search → exact variants: OntOS search returns cards without variant records, so `src/ontos/search-variants.ts` reads the
  page's variant groups in full and applies your rule (exact SKU wins, product match = plain link, else matching variants).
  Bounded: 8 groups per search page, 2 per header suggestion; the rest (and a failed read) keep `?variant=<query>`.
  An OntOS search response carrying the matching variant ids would remove these reads.
- Reorder: `POST /api/ontos/account/reorder` reads the signed-in customer's OntOS order and resolves the lines against the
  current catalogue of the active market; the cart quote re-prices them. Unavailable/unpriced/unknown lines are skipped
  with a notice. Order list/detail keep the real OntOS orders with your layout (period filter from real order months).
- Contacts product question: `?productId=<OntOS id>&variantIds=…` (your `?product=<slug>` is not used).

### Fallback data (OntOS has nothing yet)

- Variant weights / cart weight: OntOS merchandise has no variant weight. `src/ontos/variant-weights.ts` reads a
  server-only SKU index generated from the AKROS source feed (`scripts/variant-weights.mjs`, written by
  `generate-akros-catalog.mjs`), your approved rule (positive kg/ks and kg/m only, never inherited, ambiguous SKU =
  unknown). Cart lines carry `unitWeightKg`, refreshed by every OntOS quote. Needs a weight field in merchandise to retire.
- Variant description: none in OntOS; the modal shows the product description.
- Favourites, watched variants, variant references: browser-local as you designed (storage keys unchanged); data read live.
- Smart Address: public Smart Suggest v1 via `/api/address-suggestions`; the provider covers CZ only (SK/PL return nothing),
  other countries get manual entry.
- Password change: no signed-in change-password endpoint in the OntOS portal; your form validates and says it is not
  connected (never sends, never claims success). Forgotten-password link, billing/company/delivery profile sections and
  checkout prefill from the mock account are not ported (no OntOS fields/flows yet; OntOS saved-address actions exist
  but are not wired).
- „Cena na dotaz“ stays the demo's „Cena není dostupná“ + OntOS reason.

### Other deviations

- Variant table uses the demo's plain `Table` (performance) with your layout. Watch: the largest group has 386 rows.
- Header shows your six informational links; production stays in the catalogue sidebar.
- `patches/@techsio+ui-kit+0.56.1.patch` (Combobox key warning) is not ported: ui-kit is 0.57.0 from the workspace
  catalog; the warning is development-only. Follow-up: add the hunk to `app/patches/@techsio__ui-kit@0.57.0.patch`.
- Your browser scripts are copied (`/cs` URLs) and listed in `package.json` (`pnpm run test:browser`); several still assume
  mock flows (header notes). `content.mjs` form part would create real OntOS inquiries on stage.
- `/sk` and `/en` carry no Czech except OntOS product data, branch names/addresses (brand data) and the IČ/DIČ order
  note sent to OntOS (`6093322e5`): editorial/legal pages per language for both brands (`src/content/pages.ts`,
  `src/content/editorial.ts`, brand copy), server messages of the routes and the quote from the market dictionary
  (`requestDictionary()` in `src/ontos/http.ts`, header `x-akros-market-locale`; no header = Czech), price-unavailable
  reasons as codes worded at render time (`priceUnavailableText`), cart toasts and errors localized.

### Stage check (2026-11-02, release `67799adb3`)

Isolated headless Chrome on https://ontos-stage-akros.web-revolution.cz and https://ontos-stage-shop.web-revolution.cz,
`/cs` `/sk` `/en`, side by side with your Vercel build: home, category, product (20 and 386 variants, 1.0–3.1 s),
search incl. exact SKU, variant modal, contacts, login, favourites; add to cart → two OntOS quotes HTTP 200, cart shows
the OntOS-verified line and „Celková hmotnost“. No console errors. Remaining Czech on `/sk` `/en` was product data and
AKROS branch addresses; the ŠroubShop contact disclaimer was translated afterwards. On the shop host the only „akros“ in
HTML are product photo URLs on www.akros.cz (OntOS product data, moved to Core Media by the pseudonymisation operator).
