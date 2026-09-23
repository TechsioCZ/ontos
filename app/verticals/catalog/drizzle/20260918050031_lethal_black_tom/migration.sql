-- Existing measured choices still name purchase Quantity units. Their semantic mapping is
-- not inferable from matching UUIDs or labels; refuse migration before any DDL.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "catalog"."product_configuration_choices" WHERE "value_kind" = 'MEASURED_VALUE') THEN
    RAISE EXCEPTION 'Configuration Unit migration requires verified mapping of existing measured choices';
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "catalog"."configuration_unit_revisions" (
	"tenant_id" uuid,
	"unit_id" uuid,
	"revision" integer,
	"meaning" text NOT NULL,
	"dimension" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_configuration_unit_revisions_pk" PRIMARY KEY("tenant_id","unit_id","revision"),
	CONSTRAINT "catalog_configuration_unit_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_configuration_unit_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_configuration_unit_revisions_meaning_ck" CHECK ("meaning" = btrim("meaning") and length("meaning") between 1 and 1000),
	CONSTRAINT "catalog_configuration_unit_revisions_dimension_ck" CHECK ("dimension" = btrim("dimension") and length("dimension") between 1 and 160),
	CONSTRAINT "catalog_configuration_unit_revisions_lifecycle_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_configuration_unit_revisions_window_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "catalog_configuration_unit_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."configuration_unit_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."configuration_units" (
	"unit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_configuration_units_scope_id_uk" UNIQUE("tenant_id","unit_id"),
	CONSTRAINT "catalog_configuration_units_code_uk" UNIQUE("tenant_id","code"),
	CONSTRAINT "catalog_configuration_units_code_ck" CHECK ("code" = btrim("code") and length("code") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "catalog"."configuration_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" ADD COLUMN "unit_revision" integer;--> statement-breakpoint
ALTER TABLE "catalog"."configuration_unit_revisions" ADD CONSTRAINT "catalog_configuration_unit_revisions_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."configuration_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" DROP CONSTRAINT "catalog_configuration_choices_unit_fk", ADD CONSTRAINT "catalog_configuration_choices_unit_fk" FOREIGN KEY ("tenant_id","unit_id","unit_revision") REFERENCES "catalog"."configuration_unit_revisions"("tenant_id","unit_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" DROP CONSTRAINT "catalog_configuration_choices_kind_ck", ADD CONSTRAINT "catalog_configuration_choices_kind_ck" CHECK (("value_kind" = 'SINGLE_CHOICE' and "unit_id" is null and "unit_revision" is null) or ("value_kind" = 'MEASURED_VALUE' and "unit_id" is not null and "unit_revision" > 0));--> statement-breakpoint
CREATE POLICY "catalog_configuration_unit_revisions_tenant_select" ON "catalog"."configuration_unit_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."configuration_unit_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_unit_revisions_tenant_insert" ON "catalog"."configuration_unit_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."configuration_unit_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_unit_revisions_tenant_update" ON "catalog"."configuration_unit_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."configuration_unit_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."configuration_unit_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_unit_revisions_tenant_delete" ON "catalog"."configuration_unit_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."configuration_unit_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_units_tenant_select" ON "catalog"."configuration_units" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."configuration_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_units_tenant_insert" ON "catalog"."configuration_units" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."configuration_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_units_tenant_update" ON "catalog"."configuration_units" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."configuration_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."configuration_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_units_tenant_delete" ON "catalog"."configuration_units" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."configuration_units"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."configuration_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."configuration_unit_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_unit_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."configuration_unit_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_units_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."configuration_units" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
