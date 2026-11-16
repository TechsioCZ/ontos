-- The prices route no longer addresses one enrolled price list: the price list is named in the body. A coded
-- enrollment can no longer be reached, so it is closed, and removed where no job was ever admitted on it.
UPDATE "symmy_integration"."job_routes"
SET "active" = false
WHERE "route_key" = 'priceListPricesBatch' AND "route_code" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "symmy_integration"."job_routes" AS r
WHERE r."route_key" = 'priceListPricesBatch'
  AND r."route_code" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "symmy_integration"."import_jobs" AS j WHERE j."tenant_id" = r."tenant_id" AND j."route_id" = r."route_id"
  );
--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" DROP CONSTRAINT "symmy_job_routes_selector_ck", ADD CONSTRAINT "symmy_job_routes_selector_ck" CHECK ((
        "route_key" = 'customerGroupCustomersBatch'
        and "route_code" is not null and char_length("route_code") between 1 and 300
      ) or (
        "route_key" in ('customersBatch', 'priceListsBatchUpsert', 'productsBatch', 'customerGroupsBatch', 'inventoryStockBatch', 'adminCustomers', 'adminProducts', 'adminRegions', 'priceLists', 'assortmentRulesFixtureBatch', 'sellerVatDeclarationsFixtureBatch') and "route_code" is null
      ) or (
        "route_key" = 'priceListPricesBatch'
        and ("route_code" is null or (not "active" and char_length("route_code") between 1 and 300))
      ));