CREATE TABLE "catalog"."catalog_media_assignment_revisions" (
	"tenant_id" uuid,
	"assignment_id" uuid,
	"assignment_set_id" uuid NOT NULL,
	"revision" integer,
	"set_revision" integer NOT NULL,
	"resource_kind" text NOT NULL,
	"owner_module_id" text NOT NULL,
	"owner_resource_type" text NOT NULL,
	"owner_resource_id" uuid NOT NULL,
	"owner_tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"position" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_media_assignment_revisions_pk" PRIMARY KEY("tenant_id","assignment_id","revision"),
	CONSTRAINT "catalog_media_assignment_revisions_revision_ck" CHECK ("revision" > 0 and "set_revision" > 0),
	CONSTRAINT "catalog_media_assignment_revisions_kind_ck" CHECK ("resource_kind" in ('MEDIA', 'DOCUMENT')),
	CONSTRAINT "catalog_media_assignment_revisions_owner_tenant_ck" CHECK ("owner_tenant_id" = "tenant_id"),
	CONSTRAINT "catalog_media_assignment_revisions_owner_ck" CHECK ("owner_module_id" = btrim("owner_module_id") and length("owner_module_id") between 1 and 160 and "owner_resource_type" = btrim("owner_resource_type") and length("owner_resource_type") between 1 and 160),
	CONSTRAINT "catalog_media_assignment_revisions_purpose_ck" CHECK ("purpose" = btrim("purpose") and length("purpose") between 1 and 160),
	CONSTRAINT "catalog_media_assignment_revisions_position_ck" CHECK ("position" > 0),
	CONSTRAINT "catalog_media_assignment_revisions_state_ck" CHECK ("state" in ('ACTIVE', 'REMOVED')),
	CONSTRAINT "catalog_media_assignment_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."catalog_media_assignment_set_revisions" (
	"tenant_id" uuid,
	"assignment_set_id" uuid,
	"revision" integer,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_media_assignment_set_revisions_pk" PRIMARY KEY("tenant_id","assignment_set_id","revision"),
	CONSTRAINT "catalog_media_assignment_set_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_media_assignment_set_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_media_assignment_set_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_set_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."catalog_media_assignment_sets" (
	"assignment_set_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"current_revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_media_assignment_sets_scope_id_uk" UNIQUE("tenant_id","assignment_set_id"),
	CONSTRAINT "catalog_media_assignment_sets_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."catalog_media_assignments" (
	"assignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"assignment_set_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"resource_kind" text NOT NULL,
	"owner_module_id" text NOT NULL,
	"owner_resource_type" text NOT NULL,
	"owner_resource_id" uuid NOT NULL,
	"owner_tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"position" integer NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_media_assignments_scope_id_uk" UNIQUE("tenant_id","assignment_id"),
	CONSTRAINT "catalog_media_assignments_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_media_assignments_kind_ck" CHECK ("resource_kind" in ('MEDIA', 'DOCUMENT')),
	CONSTRAINT "catalog_media_assignments_owner_tenant_ck" CHECK ("owner_tenant_id" = "tenant_id"),
	CONSTRAINT "catalog_media_assignments_owner_ck" CHECK ("owner_module_id" = btrim("owner_module_id") and length("owner_module_id") between 1 and 160 and "owner_resource_type" = btrim("owner_resource_type") and length("owner_resource_type") between 1 and 160),
	CONSTRAINT "catalog_media_assignments_purpose_ck" CHECK ("purpose" = btrim("purpose") and length("purpose") between 1 and 160),
	CONSTRAINT "catalog_media_assignments_position_ck" CHECK ("position" > 0),
	CONSTRAINT "catalog_media_assignments_state_ck" CHECK ("state" in ('ACTIVE', 'REMOVED'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_localized_fact_revisions" (
	"tenant_id" uuid,
	"product_id" uuid,
	"locale" text,
	"revision" integer,
	"state" text NOT NULL,
	"name" text,
	"description" text,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_localized_fact_revisions_pk" PRIMARY KEY("tenant_id","product_id","locale","revision"),
	CONSTRAINT "catalog_product_localized_fact_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_localized_fact_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_localized_fact_revisions_state_ck" CHECK ("state" in ('SET', 'REMOVED')),
	CONSTRAINT "catalog_product_localized_fact_revisions_name_ck" CHECK ("name" is null or ("name" = btrim("name") and length("name") between 1 and 240)),
	CONSTRAINT "catalog_product_localized_fact_revisions_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") between 1 and 4000)),
	CONSTRAINT "catalog_product_localized_fact_revisions_shape_ck" CHECK (("state" = 'SET' and ("name" is not null or "description" is not null)) or ("state" = 'REMOVED' and "name" is null and "description" is null)),
	CONSTRAINT "catalog_product_localized_fact_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_localized_fact_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_localized_facts" (
	"tenant_id" uuid,
	"product_id" uuid,
	"locale" text,
	"current_revision" integer NOT NULL,
	"state" text NOT NULL,
	"name" text,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_localized_facts_pk" PRIMARY KEY("tenant_id","product_id","locale"),
	CONSTRAINT "catalog_product_localized_facts_locale_ck" CHECK ("locale" = btrim("locale") and length("locale") between 2 and 64),
	CONSTRAINT "catalog_product_localized_facts_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_product_localized_facts_state_ck" CHECK ("state" in ('SET', 'REMOVED')),
	CONSTRAINT "catalog_product_localized_facts_name_ck" CHECK ("name" is null or ("name" = btrim("name") and length("name") between 1 and 240)),
	CONSTRAINT "catalog_product_localized_facts_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") between 1 and 4000)),
	CONSTRAINT "catalog_product_localized_facts_shape_ck" CHECK (("state" = 'SET' and ("name" is not null or "description" is not null)) or ("state" = 'REMOVED' and "name" is null and "description" is null))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_localized_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."variant_localized_fact_revisions" (
	"tenant_id" uuid,
	"product_id" uuid,
	"variant_id" uuid,
	"locale" text,
	"revision" integer,
	"state" text NOT NULL,
	"name" text,
	"description" text,
	"reason" text NOT NULL,
	"evidence_refs" text[] NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_variant_localized_fact_revisions_pk" PRIMARY KEY("tenant_id","product_id","variant_id","locale","revision"),
	CONSTRAINT "catalog_variant_localized_fact_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_variant_localized_fact_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_variant_localized_fact_revisions_state_ck" CHECK ("state" in ('SET', 'REMOVED')),
	CONSTRAINT "catalog_variant_localized_fact_revisions_name_ck" CHECK ("name" is null or ("name" = btrim("name") and length("name") between 1 and 240)),
	CONSTRAINT "catalog_variant_localized_fact_revisions_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") between 1 and 4000)),
	CONSTRAINT "catalog_variant_localized_fact_revisions_shape_ck" CHECK (("state" = 'SET' and ("name" is not null or "description" is not null)) or ("state" = 'REMOVED' and "name" is null and "description" is null)),
	CONSTRAINT "catalog_variant_localized_fact_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."variant_localized_fact_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."variant_localized_facts" (
	"tenant_id" uuid,
	"product_id" uuid,
	"variant_id" uuid,
	"locale" text,
	"current_revision" integer NOT NULL,
	"state" text NOT NULL,
	"name" text,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_variant_localized_facts_pk" PRIMARY KEY("tenant_id","product_id","variant_id","locale"),
	CONSTRAINT "catalog_variant_localized_facts_locale_ck" CHECK ("locale" = btrim("locale") and length("locale") between 2 and 64),
	CONSTRAINT "catalog_variant_localized_facts_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_variant_localized_facts_state_ck" CHECK ("state" in ('SET', 'REMOVED')),
	CONSTRAINT "catalog_variant_localized_facts_name_ck" CHECK ("name" is null or ("name" = btrim("name") and length("name") between 1 and 240)),
	CONSTRAINT "catalog_variant_localized_facts_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") between 1 and 4000)),
	CONSTRAINT "catalog_variant_localized_facts_shape_ck" CHECK (("state" = 'SET' and ("name" is not null or "description" is not null)) or ("state" = 'REMOVED' and "name" is null and "description" is null))
);
--> statement-breakpoint
ALTER TABLE "catalog"."variant_localized_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_media_assignment_sets_product_uk" ON "catalog"."catalog_media_assignment_sets" ("tenant_id","product_id") WHERE "variant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_media_assignment_sets_variant_uk" ON "catalog"."catalog_media_assignment_sets" ("tenant_id","product_id","variant_id") WHERE "variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_media_assignments_active_position_uk" ON "catalog"."catalog_media_assignments" ("tenant_id","assignment_set_id","resource_kind","position") WHERE "state" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_revisions" ADD CONSTRAINT "catalog_media_assignment_revisions_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "catalog"."catalog_media_assignments"("tenant_id","assignment_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_revisions" ADD CONSTRAINT "catalog_media_assignment_revisions_set_fk" FOREIGN KEY ("tenant_id","assignment_set_id") REFERENCES "catalog"."catalog_media_assignment_sets"("tenant_id","assignment_set_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_set_revisions" ADD CONSTRAINT "catalog_media_assignment_set_revisions_set_fk" FOREIGN KEY ("tenant_id","assignment_set_id") REFERENCES "catalog"."catalog_media_assignment_sets"("tenant_id","assignment_set_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_sets" ADD CONSTRAINT "catalog_media_assignment_sets_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_sets" ADD CONSTRAINT "catalog_media_assignment_sets_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignments" ADD CONSTRAINT "catalog_media_assignments_set_fk" FOREIGN KEY ("tenant_id","assignment_set_id") REFERENCES "catalog"."catalog_media_assignment_sets"("tenant_id","assignment_set_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_localized_fact_revisions" ADD CONSTRAINT "catalog_product_localized_fact_revisions_fact_fk" FOREIGN KEY ("tenant_id","product_id","locale") REFERENCES "catalog"."product_localized_facts"("tenant_id","product_id","locale") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_localized_facts" ADD CONSTRAINT "catalog_product_localized_facts_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."variant_localized_fact_revisions" ADD CONSTRAINT "catalog_variant_localized_fact_revisions_fact_fk" FOREIGN KEY ("tenant_id","product_id","variant_id","locale") REFERENCES "catalog"."variant_localized_facts"("tenant_id","product_id","variant_id","locale") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."variant_localized_facts" ADD CONSTRAINT "catalog_variant_localized_facts_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "catalog"."product_variants"("tenant_id","product_id","variant_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_revisions_tenant_select" ON "catalog"."catalog_media_assignment_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_revisions_tenant_insert" ON "catalog"."catalog_media_assignment_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_media_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_revisions_tenant_update" ON "catalog"."catalog_media_assignment_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_media_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_revisions_tenant_delete" ON "catalog"."catalog_media_assignment_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_set_revisions_tenant_select" ON "catalog"."catalog_media_assignment_set_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_set_revisions_tenant_insert" ON "catalog"."catalog_media_assignment_set_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_media_assignment_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_set_revisions_tenant_update" ON "catalog"."catalog_media_assignment_set_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_media_assignment_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_set_revisions_tenant_delete" ON "catalog"."catalog_media_assignment_set_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_sets_tenant_select" ON "catalog"."catalog_media_assignment_sets" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_sets_tenant_insert" ON "catalog"."catalog_media_assignment_sets" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_media_assignment_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_sets_tenant_update" ON "catalog"."catalog_media_assignment_sets" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_media_assignment_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignment_sets_tenant_delete" ON "catalog"."catalog_media_assignment_sets" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_media_assignment_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignments_tenant_select" ON "catalog"."catalog_media_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."catalog_media_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignments_tenant_insert" ON "catalog"."catalog_media_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."catalog_media_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignments_tenant_update" ON "catalog"."catalog_media_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."catalog_media_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."catalog_media_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_media_assignments_tenant_delete" ON "catalog"."catalog_media_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."catalog_media_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_fact_revisions_tenant_select" ON "catalog"."product_localized_fact_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_fact_revisions_tenant_insert" ON "catalog"."product_localized_fact_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_fact_revisions_tenant_update" ON "catalog"."product_localized_fact_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_fact_revisions_tenant_delete" ON "catalog"."product_localized_fact_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_facts_tenant_select" ON "catalog"."product_localized_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_facts_tenant_insert" ON "catalog"."product_localized_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_facts_tenant_update" ON "catalog"."product_localized_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_localized_facts_tenant_delete" ON "catalog"."product_localized_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_fact_revisions_tenant_select" ON "catalog"."variant_localized_fact_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."variant_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_fact_revisions_tenant_insert" ON "catalog"."variant_localized_fact_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."variant_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_fact_revisions_tenant_update" ON "catalog"."variant_localized_fact_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."variant_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."variant_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_fact_revisions_tenant_delete" ON "catalog"."variant_localized_fact_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."variant_localized_fact_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_facts_tenant_select" ON "catalog"."variant_localized_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."variant_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_facts_tenant_insert" ON "catalog"."variant_localized_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."variant_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_facts_tenant_update" ON "catalog"."variant_localized_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."variant_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."variant_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_variant_localized_facts_tenant_delete" ON "catalog"."variant_localized_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."variant_localized_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_set_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignment_sets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."catalog_media_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_localized_fact_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_localized_facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."variant_localized_fact_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."variant_localized_facts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER "catalog_media_assignment_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."catalog_media_assignment_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_media_assignment_set_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."catalog_media_assignment_set_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_localized_fact_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."product_localized_fact_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_variant_localized_fact_revisions_append_only" BEFORE UPDATE OR DELETE ON "catalog"."variant_localized_fact_revisions" FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE FUNCTION "catalog"."protect_410_identity"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.current_revision <= OLD.current_revision THEN
    RAISE EXCEPTION 'catalog descriptive identity or revision is invalid' USING ERRCODE = '55000';
  END IF;
  IF (TG_TABLE_NAME = 'product_localized_facts' AND (NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.locale IS DISTINCT FROM OLD.locale))
    OR (TG_TABLE_NAME = 'variant_localized_facts' AND (NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.locale IS DISTINCT FROM OLD.locale))
    OR (TG_TABLE_NAME = 'catalog_media_assignment_sets' AND (NEW.assignment_set_id IS DISTINCT FROM OLD.assignment_set_id OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id))
    OR (TG_TABLE_NAME = 'catalog_media_assignments' AND (NEW.assignment_id IS DISTINCT FROM OLD.assignment_id OR NEW.assignment_set_id IS DISTINCT FROM OLD.assignment_set_id)) THEN
    RAISE EXCEPTION 'catalog descriptive identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "catalog_product_localized_facts_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."product_localized_facts" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_410_identity"();
--> statement-breakpoint
CREATE TRIGGER "catalog_variant_localized_facts_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."variant_localized_facts" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_410_identity"();
--> statement-breakpoint
CREATE TRIGGER "catalog_media_assignment_sets_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."catalog_media_assignment_sets" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_410_identity"();
--> statement-breakpoint
CREATE TRIGGER "catalog_media_assignments_identity_immutable" BEFORE UPDATE OR DELETE ON "catalog"."catalog_media_assignments" FOR EACH ROW EXECUTE FUNCTION "catalog"."protect_410_identity"();
