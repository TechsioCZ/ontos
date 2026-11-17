ALTER TABLE "symmy_integration"."job_routes" ADD CONSTRAINT "symmy_job_routes_price_source_ck" CHECK ("fixture_plan" is null or not ("fixture_plan" ? 'priceSource') or (
        "route_key" in ('priceListsBatchUpsert', 'priceListPricesBatch')
        and jsonb_typeof("fixture_plan" -> 'priceSource' -> 'mapping') = 'object'
        and jsonb_typeof("fixture_plan" -> 'priceSource' -> 'sourceAuthority') = 'object'
      ));