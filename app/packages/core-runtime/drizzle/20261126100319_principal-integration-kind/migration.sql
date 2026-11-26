-- The connector partner (symmy, ...) an integration Principal authenticates for, named when it is created.
ALTER TABLE "core"."principals" ADD COLUMN "integration_kind" text;--> statement-breakpoint
ALTER TABLE "core"."principals" ADD CONSTRAINT "core_principals_integration_kind_ck" CHECK ("integration_kind" is null or ("kind" = 'integration' and "integration_kind" ~ '^[a-z][a-z0-9-]{0,39}$'));
