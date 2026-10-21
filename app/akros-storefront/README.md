# AKROS storefront prototype

Standalone Next.js storefront prototype based on the AKROS Figma handoff. It consumes
`@techsio/ui-kit` and keeps all demo catalog/cart behavior inside this directory.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

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

`npm run test:catalog` checks catalog/variant token consumption and purchase/filter/pagination
flows at 1920, 1024 and 390px. It covers minimum quantities, whole packages, empty filter results,
keyboard slider changes and preservation of the search query when paging through results.

`npm run test:shared-ui` checks header/menu/search/footer token consumption and layout at twelve
widths from 320 to 1920px, search keyboard/all-results navigation, mobile menu close/focus and
internal footer links. Utility navigation uses Button tokens, with a line-height utility for
the Button API gap. Footer columns use the shared component's `layout="col"` and `--footer-cols`.

With the storefront running, `npm run test:home` checks homepage overflow, product stock rows
and reachable carousel controls at 34 widths from 320 to 2560 px, including breakpoint edges.
It also exercises every mobile indicator, both arrows and keyboard navigation. Set
`AKROS_HOME_SCREENSHOTS` to save screenshots. Below 431 px, carousel indicators sit beneath
the banner so their 44 px targets do not overlap the arrows.

`npm run test:responsive` includes this homepage check, then checks variant-table text and controls
at 22 widths and cart/review rows at 23 widths from 320 to 1920 px. Variant checks also cover
filter overflow, readable price endpoints and the price/submit group across four products.
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
Popover's shadow alias is also resolved during compilation, so the mini-cart keeps `shadow-md`.
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
- No API, database, authentication, checkout submission, or OntOS application module is used.
- `npm run check` runs formatting, linting, type checking, tests, and the production build.

Original checkout implementation history: [CHECKOUT-PLAN.md](CHECKOUT-PLAN.md).
Design reference: [AKROS redesign in Figma](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1261).
