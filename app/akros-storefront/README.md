# AKROS storefront prototype

Standalone Next.js storefront prototype based on the AKROS Figma handoff. It consumes
`@techsio/ui-kit` and keeps all demo catalog/cart behavior inside this directory.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

`npm install`/`npm ci` applies the versioned `@techsio/ui-kit@0.56.1` Combobox patch
via `patch-package`. Its selection renderer passed the static label/check-indicator pair
as an unkeyed children array, causing React development errors even with unique option IDs.
The patch passes these two static children as separate `createElement` arguments, preserving
the option keys and selection behavior. See [React's static-children contract](https://react.dev/reference/react/createElement#caveats).
Do not disable lifecycle scripts when installing. Restart an already-running dev server after
the patch changes. Remove this patch, hook and tool dependency once a published UI-kit version
contains the fix; the checkout component regression test must continue passing.

The six-part UI-kit refactor, its progress and component adoption inventories are tracked in
[UI-KIT-REFACTOR.md](./UI-KIT-REFACTOR.md).

The next feature implementation plan maps the 17 demo-shop requests to GitHub issues,
acceptance criteria, dependencies and unresolved integration decisions in
[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md). Executable task statuses live in
the linked `plans/akros-*.plan.md` files; the completed UI-kit refactor is a separate milestone.

With the storefront running, `npm run test:browser` runs all browser suites. `npm run check`
remains the formatter/linter/type/unit-test/production-build gate; run the browser checks after
the build. `npm run test:audit` checks 31 routes at 19 widths from 320 to 2560px, including
breakpoint edges, actual favorite-button tokens and payment validation after delivery changes.
Its compact report is written to `test-results/ui-audit/report.json`.

`npm run test:favorites` checks variant selection, filtered bulk selection, cancellation,
reload persistence, removal, storage failures and independent products. It checks the full
386-variant group and nine widths from 320 to 1920 px, the card trigger, native/fallback
sharing and the product print sheet. Screenshots and a sample PDF are saved under
`test-results/favorites/`.

`npm run test:variant-detail` checks the exact variant modal at eight desktop/mobile
sizes, including 320 × 480 px. It covers keyboard image previews, history and return
focus, direct/reloaded links, independent favorites/watch state, purchase identity,
sharing and prefilled questions, invalid IDs and missing images/descriptions.
Screenshots are saved under `test-results/variant-detail/`.

`npm run test:product-information` checks the description below the overview and
delivery information below product actions at eight widths from 320 to 1920 px.
It covers missing, short and mixed material descriptions, modal/print consistency,
delivery navigation and distinct/missing variant weights without inheriting a parent weight.
Screenshots and the layout report are in `test-results/product-information/`.

`npm run test:variant-list` checks all 47/386 variants without pagination at eight
desktop/mobile widths, the last variant and its modal/focus, purchase identity,
filter recovery and exact shared/SKU links. Screenshots and local interaction timings
are saved under `test-results/variant-list/`.

`npm run test:variant-filters` checks live dimension filters for fasteners, sheets
and round/rectangular tubes at four desktop/mobile widths. It verifies empty and
decimal editing with both separators, focus, keyboard/pointer sliders and recovery
from empty results on 386 variants. Screenshots and timings are in
`test-results/variant-filters/`. Unknown or conflicting dimensions are omitted;
price and material filters are removed.

`npm run test:prices` checks eight catalog/account price surfaces at 1920/1024/390/320 px
against source items, plus group/exact autocomplete, a concrete variant purchase and
its cart total. Unselected groups show `Cena dle varianty`; concrete items keep their
actual price. Screenshots and the card-count report are in `test-results/product-prices/`.

`npm run test:catalog` checks catalog/variant token consumption and purchase/filter/pagination
flows at 1920, 1024 and 390px. It covers minimum quantities, whole packages, empty filter results,
keyboard slider changes and preservation of the search query when paging through results.

`npm run test:shared-ui` checks header/menu/search/footer token consumption and layout at twelve
widths from 320 to 1920px, search keyboard/all-results navigation, mobile menu close/focus and
internal footer links. Utility navigation uses Button tokens, with a line-height utility for
the Button API gap. Footer columns use the shared component's `layout="col"` and `--footer-cols`.
It also checks the six informational links, keyboard navigation to each page, active links,
home via the logo and preserved desktop/mobile access to the catalog.

`npm run test:search-routing` checks exact variant links from suggestions and full search
results at 1920/1024/390/320 px. It covers prefix-colliding and duplicate SKUs, selection
after reload, modal identity, keyboard/pointer navigation and variant/group prices.
Screenshots and the report are saved under `test-results/search-routing/`.

`npm run test:selects` checks the shared select appearance against Figma node 7:1992
at 17 widths from 320 to 1920 px: checkout countries, account country, order filters
and pickup point. It covers keyboard/pointer selection, arrow rotation, validation,
filtering and isolation from the PhoneInput country picker. Screenshots and the
measurement report are saved under `test-results/select-appearance/`.
The overrides live in `src/tokens/components/molecules/_akros-select.css`, scoped
through the shared `CheckoutSelect` wrapper. The indicator reuses the existing
Figma SVG because the kit trigger has no icon-source prop; the kit still owns
the indicator and its open-state rotation.

With the storefront running, `npm run test:home` checks homepage overflow, product stock rows
and reachable carousel controls at 34 widths from 320 to 2560 px, including breakpoint edges.
It also exercises every mobile indicator, both arrows and keyboard navigation. Set
`AKROS_HOME_SCREENSHOTS` to save screenshots. Below 431 px, carousel indicators sit beneath
the banner so their 44 px targets do not overlap the arrows.

`npm run test:responsive` includes this homepage check, then checks variant-table text and controls
at 22 widths and cart/review rows at 23 widths from 320 to 1920 px. Variant checks also cover
filter overflow and readable dimension endpoints across four products.
Cart fixtures include long
product names, six-decimal quantities and large totals, and use an isolated browser context.
The checkout-section check also covers navigation/sidebar geometry, named-cart creation,
switching, persistence and deletion, and address input border/height tokens.
The typography/services check compares the four checkout steps with Figma text sizes and
weights, verifies the local Inter font and original service icons, and exercises service
selection, reload persistence, free shipping and the completed order snapshot.
It uses installed Chrome; `AKROS_CHROMIUM_PATH` can select
another Chromium executable and `AKROS_TEST_BASE_URL` can select another local server.
Set `AKROS_CART_SCREENSHOTS` to a directory to save cart/review screenshots at selected widths.

Variant rows use the original table above 1000 px of available content, a three-group list
between 640 and 1000 px, and mobile cards below 640 px. The intermediate list groups the
name/SKU, availability/price and purchase controls without changing order rules. Filter
groups grow within the available space; price and submit stay together. Price endpoint
width comes from a token supplied with the longest formatted bound's character count.
Whole-package buttons use the compact Figma layout (128 × 38 px on desktop, 48 px high in
the list/card layouts). The intermediate purchase width follows the quantity, gap and button
tokens, leaving room for complete SKUs. Variant layout checks also cover two real 18-character
codes at six widths and check that codes stay on one line without clipping.
On desktop, purchase columns follow the combined widths of the two control groups, with a
small gap between each quantity and its button. The name column takes the remaining space.

## Theme tokens

The storefront imports the generated AKROS variable export from
`@techsio/ui-kit/tokens/figma/akros/variables`. Color and spacing values should be updated in the
AKROS Figma theme and released through the UI kit instead of being copied into this application.
App component mappings live under `src/tokens/components/`; checkout-specific overrides
are scoped to `[data-akros-checkout]`. They reuse UI-kit variables for component colors,
typography and dimensions. Page composition uses inline Tailwind utilities.
The accepted storefront dimensions live in `src/tokens/_akros-layout.css`; header dimensions
stay with the header tokens. Shared Input/Textarea surface mappings live in their atom token
files. Global CSS contains page composition rather than component-token assignments.
Reviewed checkout nodes additionally define scoped Figma values for typography, borders,
control shapes and colors. The root layout loads the existing local Inter font once
and exposes it through `--font-akros` to the UI-kit font tokens. Pages and portalled
surfaces inherit the same font. Aktiv Grotesk
from the design is currently represented by Inter because its font asset is unavailable.

With the storefront running, `npm run test:typography` verifies actual rendered Inter
through Chrome DevTools across eleven routes at desktop and mobile widths, including the
country/phone dropdowns, cart dialog and mobile search. `AKROS_FONT_SCREENSHOTS` can
select a directory for screenshots and the measured font report.

Footer social icons in `src/icons/akros/` are original SVG exports from Figma node `8:3333`.
The Iconify Tailwind plugin loads them as the local `akros` collection, used through the
UI-kit `Icon` component. Keep their paths, view boxes and internal padding from the design.

With the storefront running, `npm run test:theme` checks that carousel dots and controls,
product card accents and CTA weights, header account/favorites controls, the cart count badge,
the mini-cart trigger and portalled preview, checkout actions and cart quantity inputs respond
to their UI-kit tokens. It also checks the quantity input's hover/focus
surfaces. Run it alongside the responsive, account and typography browser suites when changing
token mappings; these browser checks are separate from `npm run check`.
The theme check also probes product detail badge colors, favorite button colors/padding and
purchase quantity padding, including isolation from the neighboring favorite button.
It also checks checkout method columns/spacing, named-cart text/spacing, step spacing/mobile
title size and compact quantity text, including both sides of the 640px breakpoint.
Account checks also probe accordion trigger spacing, heading action height and normal/invalid
checkbox border tokens. Auth links use Button color/weight tokens through `LinkButton`; server
pages render them through the small `AuthPageLink` client boundary.

`npm run test:auth` checks login/registration layout and link tokens at thirteen widths from
320 to 1920px, including the 760/761px and 960/961px layout edges. At desktop, tablet and mobile
widths it also checks native required/email/consent validation, keyboard navigation and password
anchor focus, demo submission and that credentials never enter browser storage.

`npm run test:content` checks ten content routes at twelve widths from 320 to 1920px,
including the 760/761px and 1100/1101px layout edges. At desktop, tablet and mobile it also
checks FAQ category/search/accordion behavior, both local contact forms and native validation,
keyboard anchors, news/catalog links and the actual Input/Button/LinkButton token consumption.
Content links use the `ContentLink` client boundary on server-rendered pages. Blog search
remains the existing static prototype field; contact forms only show local confirmation.

Keep remaining appearance utilities tied to a verified kit limitation. In UI kit `0.56.1`,
ProductCard uses a static `shadow-sm`, so its app shadow still needs an explicit variable utility.
Dialog and Popover shadow aliases resolve directly to `--shadow-primary`. The app semantic
mapping sets this base token to `--shadow-md` (0 4px 6px at 10% black). Shared variant dialogs
and share popovers use their defaults; the mini-cart retains its explicit shadow choice.
NumericInput hardcodes a borderless, square input and a transparent trigger; the cart's separate
input border/radius and trigger surface still need slot utilities. Button has a font-weight token
but no component line-height token, so checkout actions retain their line-height utility.

The final audit also reproduces one UI-kit/Zag limitation: after store-card payment is selected
for pickup and delivery changes to DPD, the disabled native radio can retain `checked`. The
checkout draft and visible control both clear, and continuation is blocked until an available
payment is selected. `test:audit` verifies that guard at desktop/tablet/mobile widths and records
the native state for a future kit fix; the app does not patch the library's DOM state.
Colors, input padding and font weights use scoped kit tokens. Layout and runtime measurements
(such as the quantity's character count) remain app composition.
The header account/favorites controls keep their widths as layout utilities; height, padding,
radius and text size use scoped Button tokens. The cart count uses Badge tokens for appearance
and keeps its overlay position, minimum width and height as composition. Badge has no line-height
token in `0.56.1`, so the count retains `leading-none`.

## Prototype boundary

`/muj-ucet` presents the Figma profile form. Changes are stored locally under
`akros-demo-account-profile-v1`, with validation and storage-failure feedback. Password fields
are never persisted; changing credentials and ARES lookup require integrations that this
prototype does not have. Navigation sections without an existing implementation are disabled.
The original dashboard remains at `/muj-ucet/prehled`. With the dev server running,
`npm run test:account` checks desktop geometry, nine viewport widths, persistence and validation.

The profile reference is Figma **7:2085**, whose cart sidebar is hidden. At 1920 px,
the page has one 1660 px column, 32 px panel padding, 16 px navigation-item padding,
20/30 px Inter text and an 800-weight active item. Contact content is 1160 px wide;
billing fields occupy 1159 px. Inter optical sizing is disabled to match the source
text widths. Original 24 px disclosure and 28 px select arrows use the UI-kit Icon.
Account overrides are scoped in `_akros-account.css` and contain token declarations.
The profile, overview, order history/detail, favorites, tracking and account claims
share `AccountShell`, the global Inter font, wide content column and navigation.
The additional screens adapt this visual foundation; Figma 7:2085 defines the profile,
not their page content. Overview shortcuts expose favorites and tracking without a
second sidebar. Order history has working search, month and status filters; below
1280 px it uses cards instead of a wide table. Order detail follows the selected
demo order and does not reuse the first order's products for other orders.
Account claims stays inside the account; the public `/reklamace` page remains available.
`npm run test:account` covers profile behavior and the navigation between account screens.
Button and input weights use the UI kit's component font-weight tokens; checkbox
borders use `--border-width-checkbox`. Select indicators keep their existing slot
utilities. Header, footer and checkout keep their existing layout.

Checkout demo shipping becomes free at a goods subtotal of CZK 2,000, matching the existing
shipping-information page. The optional 60-day return service costs CZK 159, with the same
demo VAT assumptions as the delivery fixtures. Both rules are local prototype configuration
in `src/mock-storefront/fixtures/checkout.ts`; they are not live AKROS business policies.

- Catalog, editorial, account, order, delivery, and payment demo data lives under
  `src/mock-storefront/fixtures/`.
- Named carts are browser-local under `akros-demo-carts-v1`; `akros-demo-cart-v3` mirrors
  the active cart and is migrated into the default cart when no collection exists.
  Each cart keeps separate contents. Cart deletion requires confirmation; the last cart remains.
- Checkout has four URL-backed steps: `/kosik`, `/kosik/doprava-platba`,
  `/kosik/dodaci-udaje`, `/kosik/shrnuti`. `/pokladna` redirects into this flow.
- The editable demo B2B profile, delivery and payment selections persist in
  `sessionStorage` under `akros-demo-checkout-v1` for the default cart and a key with the
  cart ID suffix for each additional cart. Delivery methods, prices and pickup
  points are explicit Czech-only demo fixtures, not live carrier availability.
- Completing checkout saves `akros-demo-order-v1` in the same session before clearing
  the cart. `/potvrzeni-objednavky` displays that snapshot, never a fictitious paid order.
- Existing cart snapshots remain readable. New items carry catalog net prices; for old
  snapshots without them the UI explicitly marks the tax breakdown unavailable.
- Favorites are browser-local under `akros-demo-favorites-v1`, using product and variant
  references. A product heart opens the variant chooser; a heart on a concrete variant
  toggles that variant. The header heart remains a link to `/oblibene`. Older container
  booleans are not expanded into all variants. `/api/favorites/catalog/[slug]` is a read-only
  view of the public demo catalog, loaded on demand; it stores no account data.
- Product actions reuse `VariantSelectionDialog` for favorites, watching, questions and sharing.
  Watching saves independent references under `akros-demo-watched-variants-v1`; it does not
  activate actual e-mail notifications. Questions prefill the local contact form with selected SKUs.
- Sharing supports multiple selected variants through `?variantIds=item-1,item-2` (URL encoded),
  resolved against the product's exact IDs. The existing `?variant=` free-text search still works.
  Favorites use the same exact selection links. `?variantDetail=item-1` opens a specific
  variant modal and preserves an existing list selection/search when opened from a row.
  Its actions target that variant directly; sharing from the modal opens its exact detail.
  Native sharing has copy/e-mail fallback. Print creates a
  clean product sheet without the variant list; it does not print only the current purchase page.
- Variant names are kit links with a keyboard/hover image preview. The kit Dialog is mounted
  after hydration to avoid portalled `useId` differences on direct URLs. Its maximum height
  explicitly consumes the dialog token so the body scrolls while the header/footer remain visible.
  Variant descriptions and positive raw `sourceNetWeight` come from the catalog generator;
  the modal displays documented source weights in kg and leaves missing values unknown.
  The cart uses the agreed kg/piece and usable kg/metre interpretation, resolving exact variants;
  the multi-variant container no longer displays its parent's weight.
- No account backend, database, authentication, checkout submission, or OntOS application module is used.
- The demo account seed lives in `src/mock-storefront/fixtures/account.ts`: profile, addresses,
  and five complete historical orders referencing actual catalog variants. Profile and checkout
  defaults share this seed. Reorder adds into the active existing cart using current catalog prices,
  merges matching variants, and reports stock/minimum restrictions. Historical snapshots stay intact.
  This is a local demo, not a server-side order operation or authenticated order archive.
- The separate password action accepts a typed service callback; without an account service it
  explains unavailability and never claims a successful password change.
- Cart weight resolves source kg per sales unit from the exact catalog identity, including old carts,
  unless an explicit normalized `unitWeightKg` was supplied. Positive kg/piece and kg/metre source
  values are used without physical-plausibility guesses. Missing/zero values and unsupported units
  stay unknown. Partial totals show the known sum prominently with an incomplete-data note;
  package sizes are not multiplied twice. See [weight rules](plans/akros-weight.plan.md).
- Checkout street fields call the existing Smart Suggest public v1 API through a fixed same-origin
  Next rewrite; the service itself does not expose cross-origin CORS headers. A service failure leaves
  manual address entry available. Initial inspection returned Cloudflare 1102, then live requests
  returned real RUIAN suggestions. Browser regression tests isolate its responses.
  Requests now use the deployed SDK's limit of 20 rather than 5. The service's observed search
  limitations (including Boženy Němcové in Tábor) are recorded in
  [the integration notes](plans/akros-smart-address-integration.md); missing suggestions never
  prevent manual entry.
- `npm run test:reorder-ui`, `test:favorites-routing`, `test:cart-weight`, and `test:addresses` cover
  the remaining frontend tasks and are included in `test:browser`.
- Uncommitted task-by-task review and backend dependencies: [TASK 12–17](plans/akros-tasks-12-17-review.md).
- `npm run check` runs formatting, linting, type checking, tests, and the production build.

Original checkout implementation history: [CHECKOUT-PLAN.md](CHECKOUT-PLAN.md).
Design reference: [AKROS redesign in Figma](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1261).
