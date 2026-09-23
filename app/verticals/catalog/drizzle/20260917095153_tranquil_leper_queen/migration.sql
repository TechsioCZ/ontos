CREATE TABLE "catalog"."commercial_gtin_assignment_revisions" (
	"tenant_id" uuid,
	"gtin" text,
	"revision" integer,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"package_definition_id" uuid,
	"state" text NOT NULL,
	"attribution_evidence_ref" text NOT NULL,
	"reason" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_gtin_assignment_revisions_pk" PRIMARY KEY("tenant_id","gtin","revision"),
	CONSTRAINT "catalog_gtin_assignment_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_gtin_assignment_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_gtin_assignment_revisions_state_ck" CHECK ("state" in ('CONFIRMED', 'RETIRED', 'UNRESOLVED')),
	CONSTRAINT "catalog_gtin_assignment_revisions_evidence_ck" CHECK (length(btrim("attribution_evidence_ref")) between 1 and 1000),
	CONSTRAINT "catalog_gtin_assignment_revisions_reason_ck" CHECK (length(btrim("reason")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignment_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."commercial_gtin_assignments" (
	"tenant_id" uuid,
	"gtin" text,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"package_definition_id" uuid,
	"state" text NOT NULL,
	"current_revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_gtin_assignments_pk" PRIMARY KEY("tenant_id","gtin"),
	CONSTRAINT "catalog_gtin_assignments_digits_ck" CHECK ("gtin" ~ '^[0-9]{8}([0-9]{4,6})?$'),
	CONSTRAINT "catalog_gtin_assignments_state_ck" CHECK ("state" in ('CONFIRMED', 'RETIRED', 'UNRESOLVED')),
	CONSTRAINT "catalog_gtin_assignments_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."commercial_sku_assignment_revisions" (
	"tenant_id" uuid,
	"normalized_code" text,
	"revision" integer,
	"display_code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"package_definition_id" uuid,
	"state" text NOT NULL,
	"change_kind" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_sku_assignment_revisions_pk" PRIMARY KEY("tenant_id","normalized_code","revision"),
	CONSTRAINT "catalog_sku_assignment_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_sku_assignment_revisions_code_ck" CHECK ("normalized_code" = upper(btrim("display_code"))),
	CONSTRAINT "catalog_sku_assignment_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_sku_assignment_revisions_state_ck" CHECK ("state" in ('CURRENT', 'HISTORICAL', 'UNRESOLVED')),
	CONSTRAINT "catalog_sku_assignment_revisions_kind_ck" CHECK ("change_kind" in ('ASSIGN', 'RENAME', 'RETIRE', 'CORRECT', 'MARK_UNRESOLVED')),
	CONSTRAINT "catalog_sku_assignment_revisions_reason_ck" CHECK (length(btrim("reason")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_assignment_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."commercial_sku_reservations" (
	"tenant_id" uuid,
	"normalized_code" text,
	"display_code" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"package_definition_id" uuid,
	"state" text NOT NULL,
	"current_revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_sku_reservations_pk" PRIMARY KEY("tenant_id","normalized_code"),
	CONSTRAINT "catalog_sku_reservations_code_ck" CHECK ("normalized_code" = upper(btrim("display_code")) and length("normalized_code") between 1 and 240),
	CONSTRAINT "catalog_sku_reservations_state_ck" CHECK ("state" in ('CURRENT', 'HISTORICAL', 'UNRESOLVED')),
	CONSTRAINT "catalog_sku_reservations_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_sku_reservations_current_variant_uk" ON "catalog"."commercial_sku_reservations" ("tenant_id","variant_id") WHERE "state" = 'CURRENT' and "package_definition_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_sku_reservations_current_package_uk" ON "catalog"."commercial_sku_reservations" ("tenant_id","package_definition_id") WHERE "state" = 'CURRENT' and "package_definition_id" is not null;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignment_revisions" ADD CONSTRAINT "catalog_gtin_assignment_revisions_assignment_fk" FOREIGN KEY ("tenant_id","gtin") REFERENCES "catalog"."commercial_gtin_assignments"("tenant_id","gtin") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignment_revisions" ADD CONSTRAINT "catalog_gtin_assignment_revisions_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignment_revisions" ADD CONSTRAINT "catalog_gtin_assignment_revisions_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignments" ADD CONSTRAINT "catalog_gtin_assignments_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignments" ADD CONSTRAINT "catalog_gtin_assignments_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_assignment_revisions" ADD CONSTRAINT "catalog_sku_assignment_revisions_reservation_fk" FOREIGN KEY ("tenant_id","normalized_code") REFERENCES "catalog"."commercial_sku_reservations"("tenant_id","normalized_code") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_assignment_revisions" ADD CONSTRAINT "catalog_sku_assignment_revisions_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_assignment_revisions" ADD CONSTRAINT "catalog_sku_assignment_revisions_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_reservations" ADD CONSTRAINT "catalog_sku_reservations_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_reservations" ADD CONSTRAINT "catalog_sku_reservations_package_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","package_definition_id") REFERENCES "catalog"."package_definitions"("tenant_id","product_id","variant_id","package_definition_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignment_revisions_tenant_select" ON "catalog"."commercial_gtin_assignment_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."commercial_gtin_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignment_revisions_tenant_insert" ON "catalog"."commercial_gtin_assignment_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."commercial_gtin_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignment_revisions_tenant_update" ON "catalog"."commercial_gtin_assignment_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."commercial_gtin_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."commercial_gtin_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignment_revisions_tenant_delete" ON "catalog"."commercial_gtin_assignment_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."commercial_gtin_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignments_tenant_select" ON "catalog"."commercial_gtin_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."commercial_gtin_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignments_tenant_insert" ON "catalog"."commercial_gtin_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."commercial_gtin_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignments_tenant_update" ON "catalog"."commercial_gtin_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."commercial_gtin_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."commercial_gtin_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_gtin_assignments_tenant_delete" ON "catalog"."commercial_gtin_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."commercial_gtin_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_assignment_revisions_tenant_select" ON "catalog"."commercial_sku_assignment_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."commercial_sku_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_assignment_revisions_tenant_insert" ON "catalog"."commercial_sku_assignment_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."commercial_sku_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_assignment_revisions_tenant_update" ON "catalog"."commercial_sku_assignment_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."commercial_sku_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."commercial_sku_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_assignment_revisions_tenant_delete" ON "catalog"."commercial_sku_assignment_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."commercial_sku_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_reservations_tenant_select" ON "catalog"."commercial_sku_reservations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."commercial_sku_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_reservations_tenant_insert" ON "catalog"."commercial_sku_reservations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."commercial_sku_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_reservations_tenant_update" ON "catalog"."commercial_sku_reservations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."commercial_sku_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."commercial_sku_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_sku_reservations_tenant_delete" ON "catalog"."commercial_sku_reservations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."commercial_sku_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignment_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_gtin_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_assignment_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."commercial_sku_reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_gtin_assignment_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."commercial_gtin_assignment_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_sku_assignment_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."commercial_sku_assignment_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
