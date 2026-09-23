CREATE TABLE "catalog"."product_categories" (
	"category_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"parent_category_id" uuid,
	"name" text NOT NULL,
	"lifecycle_state" text DEFAULT 'ACTIVE' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_categories_scope_id_uk" UNIQUE("tenant_id","category_id"),
	CONSTRAINT "catalog_product_categories_name_ck" CHECK ("name" = btrim("name") and length("name") between 1 and 240),
	CONSTRAINT "catalog_product_categories_state_ck" CHECK ("lifecycle_state" in ('ACTIVE', 'RETIRED')),
	CONSTRAINT "catalog_product_categories_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_product_categories_not_self_parent_ck" CHECK ("parent_category_id" is null or "parent_category_id" <> "category_id")
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_category_assignments" (
	"tenant_id" uuid,
	"product_id" uuid,
	"category_id" uuid,
	"assigned_by_action_invocation_id" uuid NOT NULL,
	"assigned_by_principal_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_category_assignments_pk" PRIMARY KEY("tenant_id","product_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_category_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_category_events" (
	"product_category_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"product_id" uuid,
	"previous_parent_category_id" uuid,
	"next_parent_category_id" uuid,
	"change_kind" text NOT NULL,
	"hierarchy_revision" integer NOT NULL,
	"assignment_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_category_events_scope_id_uk" UNIQUE("tenant_id","product_category_event_id"),
	CONSTRAINT "catalog_product_category_events_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_category_events_kind_ck" CHECK ("change_kind" in ('CREATED', 'RENAMED', 'MOVED', 'RETIRED', 'ASSIGNED', 'UNASSIGNED')),
	CONSTRAINT "catalog_product_category_events_revisions_ck" CHECK ("hierarchy_revision" >= 0 and "assignment_revision" >= 0),
	CONSTRAINT "catalog_product_category_events_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_category_hierarchy_revisions" (
	"tenant_id" uuid PRIMARY KEY,
	"hierarchy_revision" integer DEFAULT 0 NOT NULL,
	"assignment_revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_category_hierarchy_revision_ck" CHECK ("hierarchy_revision" >= 0 and "assignment_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_category_hierarchy_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_type_assignment_events" (
	"product_type_assignment_event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"previous_product_type_id" uuid,
	"next_product_type_id" uuid,
	"assignment_revision" integer NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_type_assignment_events_scope_id_uk" UNIQUE("tenant_id","product_type_assignment_event_id"),
	CONSTRAINT "catalog_product_type_assignment_events_number_uk" UNIQUE("tenant_id","product_id","assignment_revision"),
	CONSTRAINT "catalog_product_type_assignment_events_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_type_assignment_events_revision_ck" CHECK ("assignment_revision" > 0),
	CONSTRAINT "catalog_product_type_assignment_events_transition_ck" CHECK ("previous_product_type_id" is distinct from "next_product_type_id"),
	CONSTRAINT "catalog_product_type_assignment_events_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_type_assignments" (
	"tenant_id" uuid,
	"product_id" uuid,
	"product_type_id" uuid NOT NULL,
	"assignment_revision" integer DEFAULT 1 NOT NULL,
	"assigned_by_action_invocation_id" uuid NOT NULL,
	"assigned_by_principal_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_type_assignments_pk" PRIMARY KEY("tenant_id","product_id"),
	CONSTRAINT "catalog_product_type_assignments_revision_ck" CHECK ("assignment_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_type_revision_attributes" (
	"tenant_id" uuid,
	"product_type_id" uuid,
	"revision" integer,
	"attribute_definition_id" uuid,
	"level" text,
	"requirement" text NOT NULL,
	CONSTRAINT "catalog_product_type_revision_attributes_pk" PRIMARY KEY("tenant_id","product_type_id","revision","attribute_definition_id","level"),
	CONSTRAINT "catalog_product_type_revision_attributes_requirement_ck" CHECK ("requirement" in ('REQUIRED', 'OPTIONAL')),
	CONSTRAINT "catalog_product_type_revision_attributes_level_ck" CHECK ("level" in ('PRODUCT', 'VARIANT'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revision_attributes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_type_revisions" (
	"product_type_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"product_type_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_type_revisions_scope_id_uk" UNIQUE("tenant_id","product_type_revision_id"),
	CONSTRAINT "catalog_product_type_revisions_number_uk" UNIQUE("tenant_id","product_type_id","revision"),
	CONSTRAINT "catalog_product_type_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "catalog_product_type_revisions_number_ck" CHECK ("revision" > 0),
	CONSTRAINT "catalog_product_type_revisions_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "catalog"."product_types" (
	"product_type_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_types_scope_id_uk" UNIQUE("tenant_id","product_type_id"),
	CONSTRAINT "catalog_product_types_revision_ck" CHECK ("current_revision" > 0),
	CONSTRAINT "catalog_product_types_name_ck" CHECK ("name" = btrim("name") and length("name") between 1 and 240)
);
--> statement-breakpoint
ALTER TABLE "catalog"."product_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "catalog_product_categories_parent_idx" ON "catalog"."product_categories" ("tenant_id","parent_category_id");--> statement-breakpoint
CREATE INDEX "catalog_product_category_assignments_category_idx" ON "catalog"."product_category_assignments" ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "catalog_product_category_events_history_idx" ON "catalog"."product_category_events" ("tenant_id","category_id","recorded_at");--> statement-breakpoint
CREATE INDEX "catalog_product_type_assignments_type_idx" ON "catalog"."product_type_assignments" ("tenant_id","product_type_id");--> statement-breakpoint
CREATE INDEX "catalog_product_types_tenant_name_idx" ON "catalog"."product_types" ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "catalog"."product_categories" ADD CONSTRAINT "catalog_product_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_category_id") REFERENCES "catalog"."product_categories"("tenant_id","category_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_assignments" ADD CONSTRAINT "catalog_product_category_assignments_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_assignments" ADD CONSTRAINT "catalog_product_category_assignments_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "catalog"."product_categories"("tenant_id","category_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "catalog"."product_categories"("tenant_id","category_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" ADD CONSTRAINT "catalog_product_category_events_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignment_events" ADD CONSTRAINT "catalog_product_type_assignment_events_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignment_events" ADD CONSTRAINT "catalog_product_type_assignment_events_previous_fk" FOREIGN KEY ("tenant_id","previous_product_type_id") REFERENCES "catalog"."product_types"("tenant_id","product_type_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignment_events" ADD CONSTRAINT "catalog_product_type_assignment_events_next_fk" FOREIGN KEY ("tenant_id","next_product_type_id") REFERENCES "catalog"."product_types"("tenant_id","product_type_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignments" ADD CONSTRAINT "catalog_product_type_assignments_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "catalog"."products"("tenant_id","product_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignments" ADD CONSTRAINT "catalog_product_type_assignments_type_fk" FOREIGN KEY ("tenant_id","product_type_id") REFERENCES "catalog"."product_types"("tenant_id","product_type_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revision_attributes" ADD CONSTRAINT "catalog_product_type_revision_attributes_revision_fk" FOREIGN KEY ("tenant_id","product_type_id","revision") REFERENCES "catalog"."product_type_revisions"("tenant_id","product_type_id","revision") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revisions" ADD CONSTRAINT "catalog_product_type_revisions_type_fk" FOREIGN KEY ("tenant_id","product_type_id") REFERENCES "catalog"."product_types"("tenant_id","product_type_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "catalog_product_categories_tenant_select" ON "catalog"."product_categories" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_categories"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_categories_tenant_insert" ON "catalog"."product_categories" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_categories"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_categories_tenant_update" ON "catalog"."product_categories" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_categories"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_categories"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_categories_tenant_delete" ON "catalog"."product_categories" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_categories"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_assignments_tenant_select" ON "catalog"."product_category_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_category_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_assignments_tenant_insert" ON "catalog"."product_category_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_category_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_assignments_tenant_update" ON "catalog"."product_category_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_category_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_category_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_assignments_tenant_delete" ON "catalog"."product_category_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_category_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_events_tenant_select" ON "catalog"."product_category_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_category_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_events_tenant_insert" ON "catalog"."product_category_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_category_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_events_tenant_update" ON "catalog"."product_category_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_category_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_category_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_category_events_tenant_delete" ON "catalog"."product_category_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_category_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_category_hierarchy_revisions_tenant_select" ON "catalog"."product_category_hierarchy_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_category_hierarchy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_category_hierarchy_revisions_tenant_insert" ON "catalog"."product_category_hierarchy_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_category_hierarchy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_category_hierarchy_revisions_tenant_update" ON "catalog"."product_category_hierarchy_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_category_hierarchy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_category_hierarchy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_category_hierarchy_revisions_tenant_delete" ON "catalog"."product_category_hierarchy_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_category_hierarchy_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignment_events_tenant_select" ON "catalog"."product_type_assignment_events" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_type_assignment_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignment_events_tenant_insert" ON "catalog"."product_type_assignment_events" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_type_assignment_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignment_events_tenant_update" ON "catalog"."product_type_assignment_events" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_type_assignment_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_type_assignment_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignment_events_tenant_delete" ON "catalog"."product_type_assignment_events" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_type_assignment_events"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignments_tenant_select" ON "catalog"."product_type_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_type_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignments_tenant_insert" ON "catalog"."product_type_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_type_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignments_tenant_update" ON "catalog"."product_type_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_type_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_type_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_assignments_tenant_delete" ON "catalog"."product_type_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_type_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revision_attributes_tenant_select" ON "catalog"."product_type_revision_attributes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_type_revision_attributes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revision_attributes_tenant_insert" ON "catalog"."product_type_revision_attributes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_type_revision_attributes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revision_attributes_tenant_update" ON "catalog"."product_type_revision_attributes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_type_revision_attributes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_type_revision_attributes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revision_attributes_tenant_delete" ON "catalog"."product_type_revision_attributes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_type_revision_attributes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revisions_tenant_select" ON "catalog"."product_type_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_type_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revisions_tenant_insert" ON "catalog"."product_type_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_type_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revisions_tenant_update" ON "catalog"."product_type_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_type_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_type_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_type_revisions_tenant_delete" ON "catalog"."product_type_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_type_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_types_tenant_select" ON "catalog"."product_types" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("catalog"."product_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_types_tenant_insert" ON "catalog"."product_types" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("catalog"."product_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_types_tenant_update" ON "catalog"."product_types" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("catalog"."product_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("catalog"."product_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "catalog_product_types_tenant_delete" ON "catalog"."product_types" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("catalog"."product_types"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Drizzle emits ENABLE and policies; FORCE remains explicit for every tenant table.
ALTER TABLE "catalog"."product_categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_category_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_category_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_category_hierarchy_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignment_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_assignments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revision_attributes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_type_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog"."product_types" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Historical rule and event rows are never rewritten by Current operations.
CREATE TRIGGER "catalog_product_type_revisions_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_type_revisions"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_type_revision_attributes_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_type_revision_attributes"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_type_assignment_events_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_type_assignment_events"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
--> statement-breakpoint
CREATE TRIGGER "catalog_product_category_events_append_only"
BEFORE UPDATE OR DELETE ON "catalog"."product_category_events"
FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_ledger_mutation"();
