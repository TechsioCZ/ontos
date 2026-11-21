# Symmy for Akros: preparing one more item (OntOS operator)

Symmy's developers read the API at `/api/symmy/v1/docs` (Scalar) and `/api/symmy/v1/openapi.json` on the deployment
they send to. That page is generated from the routes' own schemas; its guide and examples live in
[`apps/shell-super-app/api/symmy/docs.ts`](../../apps/shell-super-app/api/symmy/docs.ts). This page is only for the
OntOS side.

Symmy sends the product. Its price and stock are accepted only after the OntOS side runs these staff Actions, in this
order, once per ERP item. The one-time Akros setup (unit `ks`, warehouse location with its `LOCATION` correlation,
inventory backend `akros-erp`, currency CZK, the products, stock, customer-groups and three price-list route
enrollments and the integration principal's workloads) is already in place on the stage.

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

8. **Price list price:** one more step 6 grant for each price of a list, per exact key: `mapping`
   `akros-symmy-price-lists-price` v1 and the list's price group as selector. Example (Akros stage),
   `example-grant-velkoobchod-AKROS-10001.json`, trimmed:

   ```json
   {
     "authority": { "sourceAuthorityRef": "akros-erp-prices", "sourceAuthorityVersion": "v1" },
     "mapping": { "mappingContractRef": "akros-symmy-price-lists-price", "mappingContractVersion": "v1" },
     "effectivePeriod": { "effectiveFrom": "2026-11-21T00:00:00.000Z" },
     "exactIdentityKey": {
       "catalogSelection": { "productRef": { "…": "…" }, "variantRef": { "…": "…" } },
       "commercialScope": {
         "channelId": "B2C",
         "marketId": "e57c614d-3911-5a52-941e-29168b1db5e4",
         "sellingLegalEntityId": "c0c78a3e-6e2a-57e0-9d0d-86253499fee7"
       },
       "currencyCode": "CZK",
       "priceGroupSelector": {
         "kind": "PRICE_GROUP",
         "priceGroupRef": {
           "moduleId": "pricing.price-group-catalog",
           "resourceId": "64cc6324-0de4-418d-bbec-7fe26077db8c",
           "resourceType": "pricing.price-group-catalog.price-group",
           "tenantId": "bceaa540-13eb-5508-9ac0-9ed7e40a2ee9"
         }
       },
       "unitBasis": { "quantity": "1", "unitRef": { "…": "…" } }
     },
     "reason": "AKROS demo: the AKROS ERP (through Symmy) is the price source of variant AKROS-10001-V1 in price list VELKOOBCHOD",
     "verificationRef": "akros-demo:erp-price-authority:velkoobchod:akros-10001-v1"
   }
   ```

Then tell Symmy the item is ready: its price (re-sent with a new key), its list prices and its stock rows are accepted.
