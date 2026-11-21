# Symmy to OntOS: the Akros quickstart

This is the contract Symmy's sender follows to deliver AKROS ERP data to OntOS through `/api/symmy/v1`. Every
request and answer below ran on the Akros stage on 2026-11-21 and is trimmed from what was saved; nothing here is
proposed. The request schemas live in [`apps/shell-super-app/api/symmy/`](../../apps/shell-super-app/api/symmy/) and
win over this page if they ever differ.

Base URL: `https://<ontos-host>/api/symmy/v1`. Ids in blocks marked **Example (Akros stage)** belong to that stage
only; never copy them to another environment.

## 1. Every call

| Header            | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `x-api-key`       | The key of the Symmy integration principal, issued and rotated by the tenant. Never logged. |
| `idempotency-key` | Required on every `POST`. 1 to 200 characters of `a-z A-Z 0-9 . _ -`.                       |
| `content-type`    | `application/json`                                                                          |

- A `POST` retried with the same `idempotency-key` replays the saved outcome; it does not run again. A corrected
  body needs a **new** key (the same key with a different body is refused with 409).
- `products/batch` answers `202` with a `jobId`; read the result at `GET /jobs/{jobId}`.
  `inventory/stock/batch` and `customer-groups/batch` answer `200` with one result per row, in request order.
- Each item has an `outcome` (`accepted`, `partial`, `not_accepted`) and one entry per owner effect:

| Effect `status`                             | Meaning                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `accepted_change`                           | Written; the value changed.                                                |
| `accepted_no_change`                        | Accepted; OntOS already held this value.                                   |
| `duplicate` (with `originalStatus`)         | This effect was already accepted earlier (for example the product create). |
| `waiting`, `executing`, `indeterminate`     | Not settled yet. Poll the job again.                                       |
| `conflict`, `invalid`, `denied`, `stale`, … | Refused by the owner.                                                      |
| `unsupported` (with `reason`)               | OntOS cannot write this part yet; the rest of the item still runs.         |

## 2. Products, texts and prices: `POST /products/batch`

One ERP item is **one product with one variant**. Prices and stock attach to the variant, so this is the shape that
works end to end today.

| Field                  | Rule                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `identifier`           | `{"type": "erpId", "value": "<ERP product id>"}`                                         |
| `name`                 | Required, 1 to 240 characters. Written when the product is created.                      |
| `description`          | Optional, up to 4000 characters. Written when the product is created.                    |
| `localized` (product)  | `[{"locale": "cs", "name", "description"}]`: the shop's texts of the product.            |
| `variants`             | Exactly one: `{"identifier": {"type": "variantId", "value": "<ERP variant id>"}, …}`.    |
| `variants[].localized` | `[{"locale": "cs", "name", "description"}]`: texts of the variant.                       |
| `variants[].sku`       | The ERP item number, 1 to 240 characters: the variant's SKU in OntOS (see below).        |
| `variants[].prices`    | `[{"amount": "125.50", "currencyCode": "CZK"}]`: amount before VAT, as a decimal string. |

- Locale: send `cs`, the Akros market's locale. Other locales are stored, but the Akros shop reads `cs`. A localized
  entry needs a `name` or a `description` (name up to 240, description up to 4000 characters).
- Price: leave out `effectiveFrom` (or send a later instant). Do not send `commercialScope`, `unitBasis` or
  `priceGroupCode`: the route supplies channel B2C, market AKROS-CZ, the Akros company and unit `ks` × 1.
- A price is accepted only for a variant the OntOS operator has granted (section 8). Without the grant the price
  effect is refused (`invalid`) or reported `unsupported` while the product and texts still go through.
- Every imported product is a Catalog **DRAFT**. The Akros demo shop (`/cs/novinky-z-erp`) and the staff product list
  show drafts.

**Limit: 16 plan items per request.** A product is one item, its variant is one more when it carries `localized`
texts or a `sku`, and each price is one more. One ERP item with variant texts (or a SKU, or both) and one price is 3
items, so send at most 5 such products per request. Eight of them (24 items) were refused with 400 and went through as
two requests of four. A variant's SKU is one more owner effect of the variant's item, never an item of its own.

**Variant SKU (`variants[].sku`).** _Built after the stage run above; not yet run on the stage._ The ERP item number
becomes the variant's SKU in OntOS: the code the Akros shop shows as "Kód varianty" and the staff product list as
"SKU". The imported product stays a draft. SKUs are unique in the tenant, compared without surrounding spaces and
without letter case (`din933-m8` and `DIN933-M8` are the same code); the spelling you send is the one shown.

| You send                                                     | Effect `status`      |
| ------------------------------------------------------------ | -------------------- |
| A first SKU for the variant                                  | `accepted_change`    |
| The SKU the variant already holds                            | `accepted_no_change` |
| Another SKU: it replaces the current one                     | `accepted_change`    |
| A SKU another variant holds, or one this variant held before | `conflict`           |
| The same SKU in another letter case                          | `conflict`           |

A replaced SKU stays reserved for the variant's history: it can never be given to another variant, nor back to this
one. A SKU refused with `conflict` writes nothing; the rest of the item still runs.

Example (Akros stage): a new product with texts and a price (`example-price-0001.json`):

```json
{
  "products": [
    {
      "identifier": { "type": "erpId", "value": "AKROS-DEMO-0001" },
      "name": "AKROS demo: ERP product 0001",
      "variants": [
        {
          "identifier": { "type": "variantId", "value": "AKROS-DEMO-0001-V1" },
          "localized": [
            {
              "locale": "cs",
              "name": "AKROS demo: ERP produkt 0001",
              "description": "Základní varianta demonstračního produktu."
            }
          ],
          "prices": [{ "amount": "125.50", "currencyCode": "CZK" }]
        }
      ]
    }
  ]
}
```

Answer `202`:

```json
{ "jobId": "bea5c936-20ba-4570-99f4-1207c6472617", "status": "queued" }
```

Product-level texts are sent the same way (`example-new-product-with-texts.json`, trimmed):

```json
{
  "identifier": { "type": "erpId", "value": "AKROS-10009" },
  "name": "Hmoždinka nylonová 8×40",
  "localized": [
    { "locale": "cs", "name": "Hmoždinka nylonová 8×40", "description": "Univerzální nylonová hmoždinka 8×40 mm …" }
  ],
  "variants": [
    {
      "identifier": { "type": "variantId", "value": "AKROS-10009-V1" },
      "localized": [{ "locale": "cs", "name": "Hmoždinka nylonová 8×40" }]
    }
  ]
}
```

### Sending a change

Re-send the whole product with the same identifiers and a new `idempotency-key`.

- **Texts:** change them in `localized`. The create effect answers `duplicate`, a changed text `accepted_change`, an
  unchanged one `accepted_no_change`. Do not change the top-level `name` or `description` of an existing product:
  on the stage that re-send answered `conflict` for the create.
- **Price:** send the new amount. A different amount revises the price (`accepted_change`); the same amount answers
  `accepted_no_change`.
- **SKU:** send the new number in `variants[].sku`; it replaces the variant's SKU as the table above says.

Example (not yet run on the stage): the existing product `AKROS-10001` gets the SKU `DIN933-M8x40-ZN` on its
variant `AKROS-10001-V1`. Send the product's own name and texts as before; only `sku` is new:

```json
{
  "products": [
    {
      "identifier": { "type": "erpId", "value": "AKROS-10001" },
      "name": "<the name AKROS-10001 was created with>",
      "variants": [
        {
          "identifier": { "type": "variantId", "value": "AKROS-10001-V1" },
          "sku": "DIN933-M8x40-ZN"
        }
      ]
    }
  ]
}
```

The job answers the create `duplicate` and the variant's SKU `accepted_change` (`accepted_no_change` when sent again).

Example (Akros stage): the price of `AKROS-DEMO-0001-V1` changed from 125.50 to 139.00
(`example-price-change-0001.json`). Job result, trimmed:

```json
{
  "jobId": "7fa67c27-4a1f-4798-ba7e-7880ed781657",
  "status": "completed_all",
  "items": [
    {
      "itemId": "88baf444-3439-4a78-b1b1-e9a09bef4751",
      "outcome": "accepted",
      "effects": [
        { "owner": "commerce.catalog", "status": "duplicate", "originalStatus": "accepted_change" },
        { "owner": "commerce.catalog", "status": "accepted_no_change" },
        { "owner": "commerce.pricing", "status": "accepted_change" }
      ]
    }
  ]
}
```

### Not supported yet

`lifecycle`, the product-level `sku` (send it on the variant), `gtin`, `categories`, `attributes`, `media`, `brand`,
`productType`, `manufacturer`, `relationships`, `sizes` and more than one variant per product. They are refused or reported `unsupported`; leave them
out. Never send `lifecycle`.

## 3. Job result: `GET /jobs/{jobId}`

Statuses: `queued`, `running`, `blocked`, then `completed_all`, `completed_partial`, `completed_none` or
`indeterminate`. A job can briefly read `indeterminate` with effects `waiting` before it settles: poll again after a
few seconds. On the stage the price change above first read `indeterminate` (effects `indeterminate`, `waiting`,
`waiting`, outcome `not_accepted`) and settled to the `completed_all` result shown in section 2.

## 4. Stock: `POST /inventory/stock/batch`

One row is the absolute on-hand quantity of one variant at one warehouse, not a delta.

| Field                | Rule                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `itemKey`            | The variant's ERP id (the `variantId` sent in `products/batch`).                        |
| `locationKey`        | The ERP warehouse key, e.g. `AKROS-SKLAD-1`.                                            |
| `quantity.amount`    | Decimal string, no sign, no exponent, no trailing fractional zero (`"2500"`, `"12.5"`). |
| `quantity.unitRef`   | The OntOS unit reference of `ks` the operator gives you; copy it unchanged.             |
| `businessObservedAt` | ISO 8601 UTC instant when the ERP observed the figure.                                  |
| `revision`           | The ERP's revision of this figure, 1 to 300 characters.                                 |
| `sourceReference`    | Your trace reference for the row, 1 to 300 characters.                                  |

- At most 16 rows per request.
- Stock is accepted only for a variant the operator prepared (section 8). One row for an item the stock route does not
  list refuses the **whole request** with 403; split unknown items out and tell the operator.

Example (Akros stage), one row of `7-stock-batch.json`:

```json
{
  "stock": [
    {
      "itemKey": "AKROS-10001-V1",
      "locationKey": "AKROS-SKLAD-1",
      "quantity": {
        "amount": "2500",
        "unitRef": {
          "moduleId": "commerce.catalog",
          "resourceId": "43d5c797-2b36-4877-85ad-caac3a674d9c",
          "resourceType": "commerce.catalog.product-unit",
          "tenantId": "bceaa540-13eb-5508-9ac0-9ed7e40a2ee9"
        }
      },
      "businessObservedAt": "2026-11-21T05:07:39.786Z",
      "revision": "1",
      "sourceReference": "erp:akros:stock:AKROS-10001-V1:1"
    }
  ]
}
```

Answer `200`, one item per row:

```json
{
  "items": [
    {
      "itemId": "4b1b7f28-4ef0-4057-bf26-c208a381bcbf",
      "itemKey": "AKROS-10001-V1",
      "locationKey": "AKROS-SKLAD-1",
      "outcome": "accepted",
      "effects": [{ "effectId": "0803474c-…", "owner": "commerce.inventory", "status": "accepted_change" }]
    }
  ]
}
```

## 5. Customer groups: `POST /customer-groups/batch`

At most 16 groups per request, each `code` once. All seven fields are required.

Example (Akros stage):

```json
{
  "customerGroups": [
    {
      "code": "VELKOOBCHOD",
      "businessCode": "VO",
      "name": "Velkoobchod",
      "description": "Velkoobchodní zákazníci AKROS",
      "meaningKey": "akros.wholesale-customers",
      "membershipCriteria": "Zákazníci, kterým AKROS ERP přiřadil velkoobchodní skupinu VO",
      "purpose": "Velkoobchodní ceny a podmínky AKROS řízené z ERP"
    }
  ]
}
```

Answer `200`:

```json
{
  "items": [
    {
      "itemId": "4eca359f-fe2f-461a-bdba-0b8049735ac3",
      "code": "VELKOOBCHOD",
      "outcome": "accepted",
      "effects": [{ "effectId": "b0b500dd-…", "owner": "commerce.customer-context", "status": "accepted_change" }]
    }
  ]
}
```

A group assigns nothing by itself: it carries no price, discount or member.

## 6. What arrived: `GET /admin/products`

Query: `limit` (1 to 100), `offset`, `q` (search text), `fields` (comma-separated, e.g.
`product.name,variantSources`). Example (Akros stage), trimmed:

```json
{
  "count": 1,
  "limit": 50,
  "offset": 0,
  "products": [
    {
      "sourceRecordId": "product:erpId:AKROS-DEMO-0001",
      "product": {
        "name": "AKROS demo: ERP product 0001",
        "lifecycle": "DRAFT",
        "productRef": { "resourceId": "d65c1973-e973-4df8-9b45-2cd8e79398de", "…": "…" },
        "variants": [{ "variantId": "5a28598e-2338-5361-8e66-04d6acfc580a", "lifecycle": "WORK_IN_PROGRESS" }]
      },
      "variantSources": [
        {
          "sourceRecordId": "variant:variantId:AKROS-DEMO-0001-V1",
          "variantId": "5a28598e-2338-5361-8e66-04d6acfc580a"
        }
      ]
    }
  ]
}
```

## 7. Common refusals

| Status | `title`                              | Meaning and what to do                                                                     |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| 400    | Invalid integration request          | The body breaks the schema or a limit (for example more than 16 plan items). Fix, new key. |
| 401    | —                                    | `x-api-key` missing or not valid.                                                          |
| 403    | Gateway context forbidden            | The key may not do this, or a stock row names an item the route does not list.             |
| 404    | Integration job not found            | `GET /jobs/{id}` with an unknown id.                                                       |
| 409    | Integration request conflict         | This `idempotency-key` was already used with a different body. Use a new key.              |
| 428    | Integration idempotency key required | `idempotency-key` header missing.                                                          |
| 429    | —                                    | Too many requests. Slow down and retry later.                                              |
| 503    | Integration unavailable              | `"retryable": true`. Retry the same body with a **new** key.                               |

Every refusal is `application/problem+json` with `type`, `title`, `status` and `detail`; the 503 also carries
`"retryable": true`.

**Not available yet:** customers and customer-group memberships (`/customers/batch`,
`/customer-groups/{code}/customers/batch`). The price-list and region routes were not exercised for Akros; do not rely on them.

## 8. OntOS operator: preparing one more item

Symmy sends the product. Its price and stock are accepted only after the OntOS side runs these staff Actions, in this
order, once per ERP item. The one-time Akros setup (unit `ks`, warehouse location with its `LOCATION` correlation,
inventory backend `akros-erp`, currency CZK, the products, stock and customer-groups route enrollments and the
integration principal's workloads) is already in place on the stage.

1. **Symmy** sends the product with its variant (`POST /products/batch`). A price sent before step 6 is not accepted.
   Read the `productRef` and `variantId` from `GET /admin/products`.
2. **Inventory › register-stock-item** (`/inventory/actions/register-stock-item`): `exactSelectionMeaning`
   `{"kind": "PRODUCT_VARIANT", "id": "catalog-variant:<variantId>"}` and the `ks` `unitRef`. Keep the `stockItemRef`.
3. **Inventory › establish-stock-position** (`/inventory/actions/establish-stock-position`): the backend's
   `ownerConfigurationRef` and `scope` = `stockItemRef`, the warehouse `stockLocationRef`,
   `customerConfigurationId: "akros"`, the `ks` `unitRef`. Keep the position `ref`.
4. **Inventory › establish-external-stock-correlation** (`/inventory/actions/establish-external-stock-correlation`):
   `externalKey` with `identifierKind: "ITEM"`, `externalValue: "<ERP variant id>"`, `namespace: "akros-erp"`,
   `externalScope: "akros"`, `customerConfigurationId: "akros"`, `issuer`
   `{"backendId": "akros-erp", "backendKind": "external_business_system"}`; `target` `{"_tag": "STOCK_ITEM", "ref":
<stockItemRef>}`; `ownerEvidenceRef: "akros-erp:ITEM:<ERP variant id>"`.
5. **Inventory › establish-catalog-to-stock-binding** (`/inventory/actions/establish-catalog-to-stock-binding`):
   `candidate.catalogSelection` = the product and variant refs, the same `exactSelectionMeaning`, the `stockItem`
   from step 2; `evidence` `{"authority": "INVENTORY_BINDING_OWNER", "ownerEvidenceRef": "…"}`.
6. **Pricing › grant-external-price-source-authority** (`/pricing/actions/grant-external-price-source-authority`,
   in the Akros company context): `authority` `akros-erp-prices` v1, `mapping` `akros-symmy-products-price` v1,
   `effectivePeriod.effectiveFrom`, and one exact `exactIdentityKey`: `catalogSelection` (product + variant),
   `commercialScope` `{channelId: "B2C", marketId: <AKROS-CZ market id>, sellingLegalEntityId: <company id>}`,
   `currencyCode: "CZK"`, `priceGroupSelector: {"kind": "NO_GROUP"}`, `unitBasis` `{quantity: "1", unitRef: <ks>}`,
   plus `reason` and `verificationRef`. The answer is `{"outcome": "STORED"}`. One grant per exact key.
7. **Stock route:** add one `stockScope` row to the `inventoryStockBatch` route request and re-enroll it:

   ```json
   {
     "customerConfigurationId": "akros",
     "issuerBackendId": "akros-erp",
     "itemKey": "<ERP variant id>",
     "locationKey": "AKROS-SKLAD-1",
     "namespace": "akros-erp",
     "scope": "akros",
     "positionRef": "<position ref from step 3>"
   }
   ```

   `pnpm --filter @app/symmy-integration ops:route-enrollment dry-run --request route.json --replace <token>`, then
   `apply … --operator <ref> --reason <text> --replace <token>`, then `verify --request route.json`. The change token
   is in every receipt of the stored route. On the stage this change raised `routeRevision` from v1 to v2.

Then tell Symmy the item is ready: its price (re-sent with a new key) and its stock rows are accepted.
