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
The local token file contains only the storefront typography stack, which is not part of the
Figma variable export.

## Prototype boundary

- Catalog, editorial, account, order, delivery, and payment demo data lives under
  `src/mock-storefront/fixtures/`.
- The cart is browser-local and persists under `akros-demo-cart-v1`.
- No API, database, authentication, checkout submission, or OntOS application module is used.
- `npm run check` runs formatting, linting, type checking, tests, and the production build.

Design reference: [AKROS in Figma](https://www.figma.com/design/6Ks7ugN9ueEwNE0rNK49Vk/Akros--Copy-?node-id=0-1&m=dev).
