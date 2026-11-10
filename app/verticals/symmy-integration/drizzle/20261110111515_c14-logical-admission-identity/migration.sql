ALTER TABLE "symmy_integration"."sync_admissions" ADD COLUMN "route_key" text;--> statement-breakpoint
UPDATE symmy_integration.sync_admissions a
SET route_key = CASE a.execution_plan #>> '{items,0,effects,0,ref,operation,moduleId}'
  WHEN 'commerce.inventory' THEN 'inventoryStockBatch'
  WHEN 'commerce.customer-context' THEN 'customerGroupsBatch'
  ELSE r.route_key
END
FROM symmy_integration.job_routes r
WHERE r.tenant_id = a.tenant_id AND r.route_id = a.route_id;--> statement-breakpoint
ALTER TABLE "symmy_integration"."sync_admissions" ALTER COLUMN "route_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "symmy_integration"."sync_admissions" ADD CONSTRAINT "symmy_sync_admissions_route_key_ck" CHECK ("route_key" in ('customerGroupsBatch', 'inventoryStockBatch'));
