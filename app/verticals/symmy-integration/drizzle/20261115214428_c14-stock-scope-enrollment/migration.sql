-- A stock route enrolls positions, not full import intents. Convert each enrolled intent to one stock scope
-- entry and drop the intents from the template. A template without any enrolled intent enrolled no position
-- and admitted nothing, so it becomes no template: the route stays closed until an operator enrolls scope.
UPDATE "symmy_integration"."job_routes" AS r
SET "fixture_plan" = (r."fixture_plan" - 'items') || jsonb_build_object(
  'items', (
    SELECT jsonb_agg(
      jsonb_set(i.item, '{effects}', (SELECT jsonb_agg(e.effect - 'intent') FROM jsonb_array_elements(i.item -> 'effects') AS e(effect)))
      ORDER BY i.ord
    )
    FROM jsonb_array_elements(r."fixture_plan" -> 'items') WITH ORDINALITY AS i(item, ord)
  ),
  'stockScope', (
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
      'customerConfigurationId', a ->> 'customerConfigurationId',
      'issuerBackendId', a #>> '{issuer,backendId}',
      'itemKey', a #>> '{itemExternalKey,externalValue}',
      'locationKey', a #>> '{locationExternalKey,externalValue}',
      'namespace', a #>> '{itemExternalKey,namespace}',
      'positionRef', a -> 'positionRef',
      'scope', a #>> '{itemExternalKey,externalScope}'
    ))
    FROM jsonb_path_query(r."fixture_plan", '$.items[*].effects[*].intent.payload.items[*]') AS a
  )
)
WHERE r."route_key" = 'inventoryStockBatch'
  AND r."fixture_plan" IS NOT NULL
  AND NOT (r."fixture_plan" ? 'stockScope')
  AND EXISTS (SELECT 1 FROM jsonb_path_query(r."fixture_plan", '$.items[*].effects[*].intent.payload.items[*]'));
--> statement-breakpoint
UPDATE "symmy_integration"."job_routes"
SET "fixture_plan" = NULL
WHERE "route_key" = 'inventoryStockBatch'
  AND "fixture_plan" IS NOT NULL
  AND NOT ("fixture_plan" ? 'stockScope');
--> statement-breakpoint
ALTER TABLE "symmy_integration"."job_routes" ADD CONSTRAINT "symmy_job_routes_stock_scope_ck" CHECK ((
        "route_key" = 'inventoryStockBatch'
        and (
          "fixture_plan" is null
          or (jsonb_typeof("fixture_plan" -> 'stockScope') = 'array' and jsonb_array_length("fixture_plan" -> 'stockScope') between 1 and 10000)
        )
      ) or (
        "route_key" <> 'inventoryStockBatch' and ("fixture_plan" is null or not ("fixture_plan" ? 'stockScope'))
      ));