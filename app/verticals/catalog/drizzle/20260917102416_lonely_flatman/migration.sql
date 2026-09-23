CREATE TABLE "catalog"."catalog_result_snapshots" (
	"tenant_id" uuid,
	"action_invocation_id" uuid,
	"acting_principal_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"encoded_result" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_result_snapshots_pk" PRIMARY KEY("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_result_snapshots_action_key_ck" CHECK ("action_key" = btrim("action_key") and length("action_key") between 1 and 200),
	CONSTRAINT "catalog_result_snapshots_schema_version_ck" CHECK ("schema_version" > 0),
	CONSTRAINT "catalog_result_snapshots_result_size_ck" CHECK (octet_length("encoded_result"::text) between 2 and 65536)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_result_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "catalog_result_snapshots_tenant_select" ON "catalog"."catalog_result_snapshots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_result_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_result_snapshots_tenant_insert" ON "catalog"."catalog_result_snapshots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_result_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_result_snapshots_tenant_update" ON "catalog"."catalog_result_snapshots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_result_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_result_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_result_snapshots_tenant_delete" ON "catalog"."catalog_result_snapshots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_result_snapshots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_result_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_result_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."catalog_result_snapshots"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
