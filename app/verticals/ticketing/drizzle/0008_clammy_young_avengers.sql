ALTER TABLE "ticketing"."task_email_values" ALTER COLUMN "normalized_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."task_email_values" ALTER COLUMN "value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ticketing"."task_collections" ADD COLUMN "locale" text DEFAULT 'en-GB' NOT NULL;--> statement-breakpoint
UPDATE "ticketing"."task_collections" AS collection
SET "locale" = tenant."default_locale"
FROM "core"."tenants" AS tenant
WHERE tenant."tenant_id" = collection."tenant_id";
