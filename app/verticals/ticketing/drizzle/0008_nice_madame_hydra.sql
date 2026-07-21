ALTER TABLE "ticketing"."task_collections" ADD COLUMN "locale" text;--> statement-breakpoint
UPDATE "ticketing"."task_collections" AS collection
SET "locale" = tenant."default_locale"
FROM "core"."tenants" AS tenant
WHERE tenant."tenant_id" = collection."tenant_id";--> statement-breakpoint
ALTER TABLE "ticketing"."task_collections" ALTER COLUMN "locale" SET NOT NULL;
