# AKROS × OntOS (standalone)

Kai's Next.js app stays independent: npm + package-lock, no pnpm workspace registration,
no federation, no OntOS vertical and no redesign. The pure catalog model lives in
`src/ontos/catalog-model.ts`; `src/mock-storefront/catalog.ts` still exports the same prototype API.
The few server pages bind the model to a request-local snapshot; client search/navigation use
`CatalogProvider`. All integration code is additive under `src/ontos` and Next route handlers.

## Modes and local startup

```sh
npm ci
npm run dev                        # default mock, exactly the local prototype
STOREFRONT_DATA_SOURCE=mock npm run build
STOREFRONT_DATA_SOURCE=mock npm start -- -p 3070

# Local OntOS demo; reads ../.env.demo.local on the SERVER only:
node scripts/with-demo-env.mjs build
node scripts/with-demo-env.mjs start # 127.0.0.1:3070
```

The wrapper defaults to `ontos`; standard npm commands default to `mock`. Explicit
`STOREFRONT_DATA_SOURCE=mock|ontos` overrides the wrapper. Never use `NEXT_PUBLIC_` for a credential.

Server environment:

| Variable | Meaning |
| --- | --- |
| `STOREFRONT_DATA_SOURCE` | `mock` (default without wrapper), or `ontos` |
| `ONTOS_AKROS_STOREFRONT_API_KEY` | Required in ontos mode; dedicated least-privilege service key |
| `ONTOS_SHELL_URL` | Shell gateway origin, default `http://localhost:3020` |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL` | Default `http://127.0.0.1:3041/active` |
| `ONTOS_COMPOSITION_REVISION` | Optional fallback if publisher unavailable |

Legal entity is pinned to `71000000-0000-4000-8000-000000000024` (AKROS demo), not supplied by a browser.

The shared demo runs committed code in `ontos-runtime`:
`app/scripts/demo/rebuild-one.sh akros-storefront`. This fast-forwards the runtime then runs only
this app's npm install/build/start. PID: `app/.scratch/demo-pids/akros-storefront.pid`;
logs: `app/.scratch/demo-logs/{build-akros-storefront,akros-storefront}.log`.
`up.sh` includes the helper; `down.sh` already stops every registered process group.

## Safety and data model

`config`, `gateway`, `catalog-server`, `quote`, `http`, and every API route import `server-only`.
Only these server modules read the key. No direct vertical/backend URL or bearer token is
serialized to the browser. Gateway implementation follows `apps/eshop-storefront/server/ontos.ts`:
fresh single-use assertion per read/action, fixed merchandise audience and AKROS legal entity,
composition refresh, 4–6 second timeouts, at most three attempts for reads with backoff.
Catalog cache is 15 seconds. Checkout uses uncached reads.

Catalog read: `records` with `{view:{storefront:true}}`. Only active/published products actually
returned by OntOS are offered. Kai's catalog JSON supplies descriptive content, imagery,
parameter labels and category presentation; it NEVER supplies live money/stock/quantities.
IDs/slugs/SKUs match the backend's seed. Missing product/variant, price, stock or minimum means
not offered, never a mock-price fallback. The curated backend seed is intentionally smaller
than the complete prototype catalog. Outage shows a Czech error, never prototype stock.

Cart remains Kai's browser-local named cart storage. `POST /api/ontos/cart` revalidates fresh
owner prices, applicable quantity tiers, stock, minimum and package multiples. Price changes
require the visible **Přijmout nové ceny** action; they are never silently accepted.
Before consent, the quote lists old → new gross unit prices, each changed line total and the
cart merchandise subtotal. The cart itself keeps its original amounts until the customer accepts.

In OntOS mode mandatory package quantities are selling constraints, not an optional discount.
`purchase-constraints.ts` rounds the owner minimum up to a complete package and publishes an
additive `quantityStep` for purchase controls, cart edits and browser storage. Both purchase
buttons therefore add only legal package multiples (including metre-based products). The UI
explains this before adding; grouped product summaries defer to each variant rather than
advertising another variant’s minimum. Mock mode has no `quantityStep` and retains Kai’s
original unit/package behavior. The server still rechecks all constraints independently.

`POST /api/ontos/orders` only constructs `PlaceStorefrontOrder`, through merchandise
`apply-command`. It validates the input and delivery details, uses the fresh aggregate revision
and an idempotency key derived from the persisted `clientRequestId` + exact payload. The owner
rechecks prices/stock/quantities and persists/deduplicates the order by clientRequestId. It never
accepts a browser-requested arbitrary Action. Origin/content-type/body-size checks protect the BFF.

The browser persists the pending request ID before sending, then stores the real order number
and owner totals in Kai's order snapshot. Confirmation survives refresh in the same tab/session.
No staff orders read or order-search endpoint is exposed to the public browser.

## Honest demo boundaries

**DEMO – objednávka nebude doručena.** Orders are real in OntOS; carriers, payment, email,
account/login and tracking are simulated. The top banner labels this on every live page.
Live checkout offers owner-supported personal pickup (0 Kč) or Zásilkovna (79 Kč).
Prototype-only free-shipping threshold/paid extended returns are not applied in ontos mode.
GoPay/Apple Pay are labels only; no payment authorization or charge occurs.

Staff: `eshop@akros.demo`, `http://localhost:3020/cs/provoz/produkty` (AKROS company).
Edit a variant net price, save, wait at most 15 seconds, reload the storefront. An existing cart
shows a price-change acceptance state; new additions use the fresh price. Orders appear in
`http://localhost:3020/cs/prodej/objednavky`.
