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

| Variable                                   | Meaning                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `STOREFRONT_DATA_SOURCE`                   | `mock` (default without wrapper), or `ontos`                       |
| `ONTOS_AKROS_STOREFRONT_API_KEY`           | Required in ontos mode; dedicated least-privilege service key      |
| `ONTOS_SHELL_URL`                          | Shell gateway origin, default `http://localhost:3020`              |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL` | Default `http://127.0.0.1:3041/active`                             |
| `ONTOS_COMPOSITION_REVISION`               | Optional fallback if publisher unavailable                         |
| `STOREFRONT_IMAGE_HOSTS`                   | Optional comma-separated extra https image hosts (build AND start) |

A commented template is in `.env.example`.

## Production deploy

```sh
npm ci
export STOREFRONT_DATA_SOURCE=ontos ONTOS_AKROS_STOREFRONT_API_KEY=… \
  ONTOS_SHELL_URL=https://… ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL=https://…/active
npm run build
npm run check:browser-bundle       # fails if the key appears anywhere in .next/static
npm start -- -p 3070 -H 0.0.0.0
```

All variables are read by the Node server at runtime (`isOntos()` / `getConfig()`); none is inlined
into the browser bundle. `STOREFRONT_IMAGE_HOSTS` is also read by `next.config.ts`, so set it for
both build and start. Any Node 22+ host that can run `next start` works; no OntOS code is bundled.

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
Catalog reads are cached per query for 10 seconds (`CATALOG_CACHE_MS`, at most 100 queries);
checkout, quote and order-revision reads are always fresh.

Catalog source (ontos mode): EVERYTHING the customer sees comes from OntOS. No page, provider or
route reads Kai's generated JSON in ontos mode (it is only imported dynamically in mock mode).
`src/ontos/catalog-server.ts` sends merchandise `records` with
`{view:{storefront:true,storefrontCatalog:{…}}}` (shape published by lane akros-sync-backend):

| Page / caller                                                            | `storefrontCatalog`                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Root layout (sidebar, header navigation, homepage, cart recommendations) | `{featured:true,pageSize:16}`                                               |
| `/kategorie/[slug]`                                                      | `{categorySlug,page,pageSize:24,sort,q?,minMinor?,maxMinor?,availability?}` |
| `/vyhledavani`                                                           | `{q,page,pageSize:24}`                                                      |
| Header suggestions `POST /api/ontos/search`                              | `{q,page:1,pageSize:6}`                                                     |
| `/produkt/[slug]`                                                        | `{slug,pageSize:1}`                                                         |
| `/novinky-a-akce`                                                        | `{flag:"new"\|"promotion",pageSize:48}`                                     |
| Cart quote / checkout                                                    | `{productIds,pageSize:50}` fresh; order revision `{pageSize:1}` fresh       |

Every response carries the published category tree, `total`, `page`, `pageSize`, `revision` and
`homepageFeaturedProductIds`. `catalog-projection.ts` maps only owner fields: names, slugs, SKUs,
`description` (authoritative; split on blank lines into detail paragraphs), gallery/images,
parameters, labels (`flags`), prices/tiers, stock and minimums. Unknown/new owner products are
offered; unpublished or inactive ones never are. Missing price, stock or minimum means not offered,
never a mock fallback. Images that `next/image` cannot serve (non-https or a host outside
`www.akros.cz/data/**` + `STOREFRONT_IMAGE_HOSTS`) become the honest "image unavailable" placeholder.
The browser receives only the featured products plus a slim category tree (no long category texts).
Kai's homepage banner carousel and content pages are static marketing content, not catalog data.
The sidebar keeps Kai's curated section order by category slug; renamed categories update live,
a category whose slug changes in OntOS drops out of that curated sidebar but stays reachable.
Outage shows a Czech error, never prototype stock.

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

**DEMO – objednávka nebude doručena.** Orders are real in OntOS; carriers, payment, email,
account/login and tracking are simulated. The top banner labels this on every live page.
Live checkout offers owner-supported personal pickup (0 Kč) or Zásilkovna (79 Kč).
Prototype-only free-shipping threshold/paid extended returns are not applied in ontos mode.
Connected checkout has only the inactive **Nic neplatíte (DEMO)** method. Old saved payment
choices are migrated to `demo-no-payment`; GoPay/Apple Pay/card choices remain in mock mode only.
New connected orders use the Czech staff note **Platba se neprovádí (DEMO).** rather than
serializing the internal payment ID (including when submitting an old saved payment choice).
Existing order notes are historical snapshots and are not rewritten by this presentation fix.
The connected CTA is **Potvrdit DEMO objednávku** with the exact notice before and after confirmation:
**E-shop je prezentační demo. Žádné zboží vám nebude doručeno a nic neplatíte.**
The production-style payment-obligation terms and newsletter signup are hidden in connected mode.
HTTP errors (including non-JSON), invalid success payloads and network failures show Czech retry
guidance without clearing the cart or inventing a local success. The same persisted submission ID
is reused on retry, including after an ambiguous response; only validated owner order numbers and
totals produce confirmation.

Connected category lists combine name/SKU text, unit/from price range (CZK with VAT), availability
and sorting (Czech name A–Z by default, price ascending/descending). Filters apply server-side to
the current permitted catalog, not to the current page only. GET query keys `q`, `min`, `max`,
`availability=in-stock|out-of-stock`, `sort=name|price-asc|price-desc` survive reload/back and
pagination. Filter submit resets pagination; **Vymazat filtry** clears the complete selection.
A grouped product uses its displayed lowest/from price; availability requires at least one variant
with its legal minimum in stock. No query parameter changes backend authorization or company.
Kai's mock category layout/order and prototype checkout wording/payment choices are unchanged.

Both modes are nonproduction: all pages inherit robots `noindex, nofollow`, every response has
`X-Robots-Tag: noindex, nofollow, noarchive`, and `/robots.txt` disallows all crawlers. This is
indexing guidance, not authentication or access control.

Staff: `eshop@akros.demo`, `http://localhost:3020/cs/provoz/produkty` (AKROS company).
Edit a product name, description, image, label, category or variant net price, save, wait at most
10 seconds, reload the storefront. An existing cart
shows a price-change acceptance state; new additions use the fresh price. Orders appear in
`http://localhost:3020/cs/prodej/objednavky`; moving an order through the workflow there updates
the open confirmation page within 10 seconds.
