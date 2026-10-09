CREATE TABLE "catalog"."product_configuration_choice_options" (
	"tenant_id" uuid,
	"definition_id" uuid,
	"revision" integer,
	"choice_key" text,
	"option_key" text,
	"meaning" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "catalog_configuration_choice_options_pk" PRIMARY KEY("tenant_id","definition_id","revision","choice_key","option_key"),
	CONSTRAINT "catalog_configuration_choice_options_key_ck" CHECK ("option_key" = btrim("option_key") and length("option_key") between 1 and 160),
	CONSTRAINT "catalog_configuration_choice_options_meaning_ck" CHECK ("meaning" = btrim("meaning") and length("meaning") between 1 and 1000),
	CONSTRAINT "catalog_configuration_choice_options_label_ck" CHECK ("label" = btrim("label") and length("label") between 1 and 240)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choice_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_configuration_choices" (
	"tenant_id" uuid,
	"definition_id" uuid,
	"revision" integer,
	"choice_key" text,
	"meaning" text NOT NULL,
	"label" text NOT NULL,
	"value_kind" text NOT NULL,
	"required" boolean NOT NULL,
	"unit_id" uuid,
	CONSTRAINT "catalog_configuration_choices_pk" PRIMARY KEY("tenant_id","definition_id","revision","choice_key"),
	CONSTRAINT "catalog_configuration_choices_key_ck" CHECK ("choice_key" = btrim("choice_key") and length("choice_key") between 1 and 160),
	CONSTRAINT "catalog_configuration_choices_meaning_ck" CHECK ("meaning" = btrim("meaning") and length("meaning") between 1 and 1000),
	CONSTRAINT "catalog_configuration_choices_label_ck" CHECK ("label" = btrim("label") and length("label") between 1 and 240),
	CONSTRAINT "catalog_configuration_choices_kind_ck" CHECK (("value_kind" = 'SINGLE_CHOICE' and "unit_id" is null) or ("value_kind" = 'MEASURED_VALUE' and "unit_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_configuration_compatibility_rules" (
	"tenant_id" uuid,
	"definition_id" uuid,
	"product_id" uuid NOT NULL,
	"revision" integer,
	"rule_id" uuid,
	"variant_id" uuid,
	"package_definition_id" uuid,
	"kind" text NOT NULL,
	"choice_key" text NOT NULL,
	"option_key" text NOT NULL,
	"other_choice_key" text NOT NULL,
	"other_option_key" text,
	"maximum" numeric,
	"maximum_inclusive" boolean,
	"evidence_refs" text[] NOT NULL,
	CONSTRAINT "catalog_configuration_compatibility_rules_pk" PRIMARY KEY("tenant_id","definition_id","revision","rule_id"),
	CONSTRAINT "catalog_configuration_compatibility_rules_kind_ck" CHECK (("kind" = 'FORBIDDEN_PAIR' and "other_option_key" is not null and "maximum" is null and "maximum_inclusive" is null) or ("kind" = 'CONDITIONAL_MAXIMUM' and "other_option_key" is null and "maximum" is not null and "maximum_inclusive" is not null)),
	CONSTRAINT "catalog_configuration_compatibility_rules_target_ck" CHECK ("package_definition_id" is null or "variant_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_configuration_definition_revisions" (
	"tenant_id" uuid,
	"definition_id" uuid,
	"product_id" uuid NOT NULL,
	"revision" integer,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_configuration_definition_revisions_pk" PRIMARY KEY("tenant_id","definition_id","revision"),
	CONSTRAINT "catalog_configuration_definition_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_configuration_definition_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_configuration_definition_revisions_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "catalog_configuration_definition_revisions_state_ck" CHECK ("state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_configuration_definition_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_definition_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_configuration_definitions" (
	"definition_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_configuration_definitions_scope_id_uk" UNIQUE("tenant_id","definition_id"),
	CONSTRAINT "catalog_configuration_definitions_product_id_uk" UNIQUE("tenant_id","product_id","definition_id"),
	CONSTRAINT "catalog_configuration_definitions_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_configuration_measured_rules" (
	"rule_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"choice_key" text NOT NULL,
	"variant_id" uuid,
	"package_definition_id" uuid,
	"minimum" numeric,
	"minimum_inclusive" boolean,
	"maximum" numeric,
	"maximum_inclusive" boolean,
	"step" numeric,
	"step_base" numeric,
	"evidence_refs" text[] NOT NULL,
	CONSTRAINT "catalog_configuration_measured_rules_bounds_ck" CHECK (("minimum" is null) = ("minimum_inclusive" is null) and ("maximum" is null) = ("maximum_inclusive" is null) and ("minimum" is null or "maximum" is null or "minimum" <= "maximum")),
	CONSTRAINT "catalog_configuration_measured_rules_step_ck" CHECK (("step" is null and "step_base" is null) or ("step" > 0 and "step_base" is not null)),
	CONSTRAINT "catalog_configuration_measured_rules_target_ck" CHECK ("package_definition_id" is null or "variant_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_measured_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_configuration_option_allowances" (
	"allowance_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"choice_key" text NOT NULL,
	"option_key" text NOT NULL,
	"variant_id" uuid,
	"package_definition_id" uuid,
	"allowed" boolean NOT NULL,
	"evidence_refs" text[] NOT NULL,
	CONSTRAINT "catalog_configuration_allowances_target_ck" CHECK ("package_definition_id" is null or "variant_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_option_allowances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_configuration_measured_rules_product_uk" ON "catalog"."product_configuration_measured_rules" ("tenant_id","definition_id","revision","choice_key") WHERE "variant_id" is null and "package_definition_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_configuration_measured_rules_variant_uk" ON "catalog"."product_configuration_measured_rules" ("tenant_id","definition_id","revision","choice_key","variant_id") WHERE "variant_id" is not null and "package_definition_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_configuration_measured_rules_package_uk" ON "catalog"."product_configuration_measured_rules" ("tenant_id","definition_id","revision","choice_key","variant_id","package_definition_id") WHERE "package_definition_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_configuration_allowances_product_uk" ON "catalog"."product_configuration_option_allowances" ("tenant_id","definition_id","revision","choice_key","option_key") WHERE "variant_id" is null and "package_definition_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_configuration_allowances_variant_uk" ON "catalog"."product_configuration_option_allowances" ("tenant_id","definition_id","revision","choice_key","option_key","variant_id") WHERE "variant_id" is not null and "package_definition_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_configuration_allowances_package_uk" ON "catalog"."product_configuration_option_allowances" ("tenant_id","definition_id","revision","choice_key","option_key","variant_id","package_definition_id") WHERE "package_definition_id" is not null;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choice_options" ADD CONSTRAINT "catalog_configuration_choice_options_choice_fk" FOREIGN KEY ("tenant_id","definition_id","revision","choice_key") REFERENCES "catalog"."product_configuration_choices"("tenant_id","definition_id","revision","choice_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" ADD CONSTRAINT "catalog_configuration_choices_revision_fk" FOREIGN KEY ("tenant_id","definition_id","revision") REFERENCES "catalog"."product_configuration_definition_revisions"("tenant_id","definition_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" ADD CONSTRAINT "catalog_configuration_choices_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "catalog"."product_units"("tenant_id","unit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" ADD CONSTRAINT "catalog_configuration_compatibility_rules_product_fk" FOREIGN KEY ("tenant_id","product_id","definition_id") REFERENCES "catalog"."product_configuration_definitions"("tenant_id","product_id","definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" ADD CONSTRAINT "catalog_configuration_compatibility_rules_option_fk" FOREIGN KEY ("tenant_id","definition_id","revision","choice_key","option_key") REFERENCES "catalog"."product_configuration_choice_options"("tenant_id","definition_id","revision","choice_key","option_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" ADD CONSTRAINT "catalog_configuration_compatibility_rules_other_choice_fk" FOREIGN KEY ("tenant_id","definition_id","revision","other_choice_key") REFERENCES "catalog"."product_configuration_choices"("tenant_id","definition_id","revision","choice_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" ADD CONSTRAINT "catalog_configuration_compatibility_rules_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" ADD CONSTRAINT "catalog_configuration_compatibility_rules_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_definition_revisions" ADD CONSTRAINT "catalog_configuration_definition_revisions_definition_fk" FOREIGN KEY ("tenant_id","product_id","definition_id") REFERENCES "catalog"."product_configuration_definitions"("tenant_id","product_id","definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_definitions" ADD CONSTRAINT "catalog_configuration_definitions_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_measured_rules" ADD CONSTRAINT "catalog_configuration_measured_rules_product_fk" FOREIGN KEY ("tenant_id","product_id","definition_id") REFERENCES "catalog"."product_configuration_definitions"("tenant_id","product_id","definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_measured_rules" ADD CONSTRAINT "catalog_configuration_measured_rules_choice_fk" FOREIGN KEY ("tenant_id","definition_id","revision","choice_key") REFERENCES "catalog"."product_configuration_choices"("tenant_id","definition_id","revision","choice_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_measured_rules" ADD CONSTRAINT "catalog_configuration_measured_rules_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_measured_rules" ADD CONSTRAINT "catalog_configuration_measured_rules_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_option_allowances" ADD CONSTRAINT "catalog_configuration_allowances_product_fk" FOREIGN KEY ("tenant_id","product_id","definition_id") REFERENCES "catalog"."product_configuration_definitions"("tenant_id","product_id","definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_option_allowances" ADD CONSTRAINT "catalog_configuration_allowances_option_fk" FOREIGN KEY ("tenant_id","definition_id","revision","choice_key","option_key") REFERENCES "catalog"."product_configuration_choice_options"("tenant_id","definition_id","revision","choice_key","option_key") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_option_allowances" ADD CONSTRAINT "catalog_configuration_allowances_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_option_allowances" ADD CONSTRAINT "catalog_configuration_allowances_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_configuration_choice_options_tenant_select" ON "catalog"."product_configuration_choice_options" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_choice_options"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choice_options_tenant_insert" ON "catalog"."product_configuration_choice_options" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_choice_options"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choice_options_tenant_update" ON "catalog"."product_configuration_choice_options" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_choice_options"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_choice_options"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choice_options_tenant_delete" ON "catalog"."product_configuration_choice_options" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_choice_options"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choices_tenant_select" ON "catalog"."product_configuration_choices" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choices_tenant_insert" ON "catalog"."product_configuration_choices" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choices_tenant_update" ON "catalog"."product_configuration_choices" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_choices_tenant_delete" ON "catalog"."product_configuration_choices" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_choices"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_compatibility_rules_tenant_select" ON "catalog"."product_configuration_compatibility_rules" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_compatibility_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_compatibility_rules_tenant_insert" ON "catalog"."product_configuration_compatibility_rules" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_compatibility_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_compatibility_rules_tenant_update" ON "catalog"."product_configuration_compatibility_rules" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_compatibility_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_compatibility_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_compatibility_rules_tenant_delete" ON "catalog"."product_configuration_compatibility_rules" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_compatibility_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definition_revisions_tenant_select" ON "catalog"."product_configuration_definition_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definition_revisions_tenant_insert" ON "catalog"."product_configuration_definition_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definition_revisions_tenant_update" ON "catalog"."product_configuration_definition_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definition_revisions_tenant_delete" ON "catalog"."product_configuration_definition_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_definition_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definitions_tenant_select" ON "catalog"."product_configuration_definitions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definitions_tenant_insert" ON "catalog"."product_configuration_definitions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definitions_tenant_update" ON "catalog"."product_configuration_definitions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_definitions_tenant_delete" ON "catalog"."product_configuration_definitions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_definitions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_measured_rules_tenant_select" ON "catalog"."product_configuration_measured_rules" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_measured_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_measured_rules_tenant_insert" ON "catalog"."product_configuration_measured_rules" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_measured_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_measured_rules_tenant_update" ON "catalog"."product_configuration_measured_rules" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_measured_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_measured_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_measured_rules_tenant_delete" ON "catalog"."product_configuration_measured_rules" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_measured_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_allowances_tenant_select" ON "catalog"."product_configuration_option_allowances" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_configuration_option_allowances"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_allowances_tenant_insert" ON "catalog"."product_configuration_option_allowances" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_configuration_option_allowances"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_allowances_tenant_update" ON "catalog"."product_configuration_option_allowances" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_configuration_option_allowances"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_configuration_option_allowances"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_configuration_allowances_tenant_delete" ON "catalog"."product_configuration_option_allowances" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_configuration_option_allowances"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_definitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_definition_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_choice_options" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_option_allowances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_measured_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_configuration_compatibility_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_definitions_identity_immutable"
BEFORE UPDATE OF tenant_id, definition_id, product_id OR DELETE ON "catalog"."product_configuration_definitions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_definition_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_definition_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_choices_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_choices"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_choice_options_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_choice_options"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_option_allowances_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_option_allowances"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_measured_rules_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_measured_rules"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_configuration_compatibility_rules_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_configuration_compatibility_rules"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
