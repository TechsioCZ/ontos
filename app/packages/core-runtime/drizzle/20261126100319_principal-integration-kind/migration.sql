-- The connector partner (symmy, ...) an integration Principal authenticates for, named when it is created.
-- Principal reads resolve every API key; never queue behind a long transaction on the table for more than a moment.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "core"."principals" ADD COLUMN "integration_kind" text;--> statement-breakpoint
ALTER TABLE "core"."principals" ADD CONSTRAINT "core_principals_integration_kind_ck" CHECK ("integration_kind" is null or ("kind" = 'integration' and "integration_kind" ~ '^[a-z][a-z0-9-]{0,39}$'));
--> statement-breakpoint
-- An integration Principal created before the kind existed and admitted as Symmy (it holds a Symmy workload) is Symmy's.
-- Only the new column is written: its keys, auth bindings and workload bindings stay exactly as they are.
UPDATE "core"."principals" AS p SET "integration_kind" = 'symmy'
WHERE p."kind" = 'integration' AND p."integration_kind" IS NULL AND EXISTS (
  SELECT 1 FROM "core"."access_workload_bindings" AS b
  WHERE b."tenant_id" = p."tenant_id" AND b."principal_id" = p."principal_id"
    AND b."workload_key" LIKE 'integration.symmy.%' AND b."status" = 'active'
);
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
