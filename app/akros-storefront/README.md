# AKROS storefront prototype

Standalone Next.js storefront prototype based on the AKROS Figma handoff. It consumes
`@techsio/ui-kit` and keeps all demo catalog/cart behavior inside this directory.

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

## Theme tokens

The storefront imports the generated AKROS variable export from
`@techsio/ui-kit/tokens/figma/akros/variables`. Color and spacing values should be updated in the
AKROS Figma theme and released through the UI kit instead of being copied into this application.
App component mappings live under `src/tokens/components/`; checkout-specific overrides
are scoped to `[data-akros-checkout]`. They reuse UI-kit variables for component colors,
typography and dimensions. Page composition uses inline Tailwind utilities.

## Prototype boundary

- Catalog, editorial, account, order, delivery, and payment demo data lives under
  `src/mock-storefront/fixtures/`.
- The cart is browser-local and persists under `akros-demo-cart-v3`.
- Checkout has four URL-backed steps: `/kosik`, `/kosik/doprava-platba`,
  `/kosik/dodaci-udaje`, `/kosik/shrnuti`. `/pokladna` redirects into this flow.
- The editable demo B2B profile, delivery and payment selections persist in
  `sessionStorage` under `akros-demo-checkout-v1`. Delivery methods, prices and pickup
  points are explicit Czech-only demo fixtures, not live carrier availability.
- Completing checkout saves `akros-demo-order-v1` in the same session before clearing
  the cart. `/potvrzeni-objednavky` displays that snapshot, never a fictitious paid order.
- Existing cart snapshots remain readable. New items carry catalog net prices; for old
  snapshots without them the UI explicitly marks the tax breakdown unavailable.
- No API, database, authentication, checkout submission, or OntOS application module is used.
- `npm run check` runs formatting, linting, type checking, tests, and the production build.

Checkout scope and design references: [CHECKOUT-PLAN.md](CHECKOUT-PLAN.md).
Design reference: [AKROS redesign in Figma](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1261).
