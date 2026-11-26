-- The first backfill matched only 'integration.symmy.%' workloads; a Symmy integration admitted through the hyphenated
-- connector workloads (integration.symmy-poll, integration.symmy-admit) stayed generic, so its Integrace card offered no
-- Symmy routes panel. Only the new column is written.
UPDATE "core"."principals" AS p SET "integration_kind" = 'symmy'
WHERE p."kind" = 'integration' AND p."integration_kind" IS NULL AND EXISTS (
  SELECT 1 FROM "core"."access_workload_bindings" AS b
  WHERE b."tenant_id" = p."tenant_id" AND b."principal_id" = p."principal_id"
    AND (b."workload_key" LIKE 'integration.symmy.%' OR b."workload_key" LIKE 'integration.symmy-%') AND b."status" = 'active'
);
