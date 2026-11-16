ALTER TABLE "symmy_integration"."job_routes" DROP CONSTRAINT "symmy_job_routes_selector_ck", ADD CONSTRAINT "symmy_job_routes_selector_ck" CHECK ((
        "route_key" in ('customerGroupCustomersBatch', 'priceListPricesBatch')
        and "route_code" is not null and char_length("route_code") between 1 and 300
      ) or (
        "route_key" in ('customersBatch', 'priceListsBatchUpsert', 'productsBatch', 'customerGroupsBatch', 'inventoryStockBatch', 'adminCustomers', 'adminProducts', 'adminRegions', 'priceLists', 'assortmentRulesFixtureBatch', 'sellerVatDeclarationsFixtureBatch') and "route_code" is null
      ));