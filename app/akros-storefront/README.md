# AKROS storefront prototype

Standalone Next.js storefront prototype based on the AKROS Figma handoff. It consumes
`@techsio/ui-kit` and keeps all demo catalog/cart behavior inside this directory.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

With the storefront running, `npm run test:responsive` checks variant-table text and controls
at 14 widths and cart/review rows at 23 widths from 320 to 1920 px. Cart fixtures include long
product names, six-decimal quantities and large totals, and use an isolated browser context.
The checkout-section check also covers navigation/sidebar geometry, named-cart creation,
switching, persistence and deletion, and address input border/height tokens.
The typography/services check compares the four checkout steps with Figma text sizes and
weights, verifies the local Inter font and original service icons, and exercises service
selection, reload persistence, free shipping and the completed order snapshot.
It uses installed Chrome; `AKROS_CHROMIUM_PATH` can select
another Chromium executable and `AKROS_TEST_BASE_URL` can select another local server.
Set `AKROS_CART_SCREENSHOTS` to a directory to save cart/review screenshots at selected widths.

## Theme tokens

The storefront imports the generated AKROS variable export from
`@techsio/ui-kit/tokens/figma/akros/variables`. Color and spacing values should be updated in the
AKROS Figma theme and released through the UI kit instead of being copied into this application.
App component mappings live under `src/tokens/components/`; checkout-specific overrides
are scoped to `[data-akros-checkout]`. They reuse UI-kit variables for component colors,
typography and dimensions. Page composition uses inline Tailwind utilities.
Reviewed checkout nodes additionally define scoped Figma values for typography, borders,
control shapes and colors. Checkout loads the existing local Inter font; Aktiv Grotesk
from the design is currently represented by Inter because its font asset is unavailable.

Footer social icons in `src/icons/akros/` are original SVG exports from Figma node `8:3333`.
The Iconify Tailwind plugin loads them as the local `akros` collection, used through the
UI-kit `Icon` component. Keep their paths, view boxes and internal padding from the design.

## Prototype boundary

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
