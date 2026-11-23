-- Retired physical routes retain their admissions and execution gates. Only an active selector
-- must be unique, so a new physical route can serve the same logical source without rewriting history.
-- Partition nullable selector fields explicitly: NULL remains one selector, not an escape from uniqueness.
ALTER TABLE symmy_integration.job_routes DROP CONSTRAINT symmy_job_routes_scope_selector_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX symmy_job_routes_active_tenant_uq
  ON symmy_integration.job_routes (tenant_id, principal_id, route_key)
  WHERE active AND legal_entity_id IS NULL AND route_code IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX symmy_job_routes_active_company_uq
  ON symmy_integration.job_routes (tenant_id, principal_id, legal_entity_id, route_key)
  WHERE active AND legal_entity_id IS NOT NULL AND route_code IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX symmy_job_routes_active_tenant_code_uq
  ON symmy_integration.job_routes (tenant_id, principal_id, route_key, route_code)
  WHERE active AND legal_entity_id IS NULL AND route_code IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX symmy_job_routes_active_company_code_uq
  ON symmy_integration.job_routes (tenant_id, principal_id, legal_entity_id, route_key, route_code)
  WHERE active AND legal_entity_id IS NOT NULL AND route_code IS NOT NULL;
