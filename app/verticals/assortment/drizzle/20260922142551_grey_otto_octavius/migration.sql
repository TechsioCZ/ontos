CREATE SCHEMA "assortment";
--> statement-breakpoint
CREATE TABLE "assortment"."assortment_admission_set_entries" (
	"admission_set_entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"admission_set_id" uuid NOT NULL,
	"coverage_kind" text NOT NULL,
	"target_resource_id" text,
	"target_resource_type" text,
	"ordinal" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_admission_entries_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","admission_set_entry_id"),
	CONSTRAINT "assortment_admission_entries_position_uk" UNIQUE("tenant_id","legal_entity_id","admission_set_id","ordinal"),
	CONSTRAINT "assortment_admission_entries_semantics_uk" UNIQUE("tenant_id","legal_entity_id","admission_set_id","coverage_kind","target_resource_id"),
	CONSTRAINT "assortment_admission_entries_kind_ck" CHECK ("coverage_kind" in ('ALL', 'CATEGORY', 'PRODUCT', 'VARIANT', 'PACKAGE_OPTION')),
	CONSTRAINT "assortment_admission_entries_ordinal_ck" CHECK ("ordinal" >= 0),
	CONSTRAINT "assortment_admission_entries_target_ck" CHECK (("coverage_kind" = 'ALL' and "target_resource_id" is null and "target_resource_type" is null) or ("coverage_kind" <> 'ALL' and "target_resource_id" is not null and "target_resource_type" is not null))
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_admission_set_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_admission_sets" (
	"admission_set_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"closed_boundary_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"set_kind" text NOT NULL,
	"collection_revision_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_admission_sets_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","admission_set_id"),
	CONSTRAINT "assortment_admission_sets_boundary_uk" UNIQUE("tenant_id","legal_entity_id","closed_boundary_id"),
	CONSTRAINT "assortment_admission_sets_collection_uk" UNIQUE("tenant_id","legal_entity_id","collection_revision_id"),
	CONSTRAINT "assortment_admission_sets_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "assortment_admission_sets_purpose_ck" CHECK ("purpose" in ('VISIBILITY', 'PURCHASE')),
	CONSTRAINT "assortment_admission_sets_kind_ck" CHECK ("set_kind" in ('EMPTY', 'ENTRIES'))
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_admission_sets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_applicability_binding_end_facts" (
	"applicability_binding_end_fact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"applicability_binding_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_binding_end_facts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","applicability_binding_end_fact_id"),
	CONSTRAINT "assortment_binding_end_facts_binding_uk" UNIQUE("tenant_id","legal_entity_id","applicability_binding_id"),
	CONSTRAINT "assortment_binding_end_facts_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_applicability_binding_end_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_applicability_bindings" (
	"applicability_binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"rule_revision_id" uuid NOT NULL,
	"binding_kind" text NOT NULL,
	"customer_group_resource_id" text,
	"subject_kind" text,
	"subject_resource_id" text,
	"channel_resource_id" text NOT NULL,
	"market_resource_id" text,
	"storefront_resource_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_bindings_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","applicability_binding_id"),
	CONSTRAINT "assortment_bindings_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "assortment_bindings_kind_ck" CHECK ("binding_kind" in ('SHARED', 'COMMERCE_CUSTOMER_GROUP', 'SUBJECT')),
	CONSTRAINT "assortment_bindings_audience_ck" CHECK (("binding_kind" = 'SHARED' and "customer_group_resource_id" is null and "subject_kind" is null and "subject_resource_id" is null) or ("binding_kind" = 'COMMERCE_CUSTOMER_GROUP' and "customer_group_resource_id" is not null and "subject_kind" is null and "subject_resource_id" is null) or ("binding_kind" = 'SUBJECT' and "customer_group_resource_id" is null and "subject_kind" in ('RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY') and "subject_resource_id" is not null)),
	CONSTRAINT "assortment_bindings_channel_ck" CHECK ("channel_resource_id" = btrim("channel_resource_id") and length("channel_resource_id") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_applicability_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_closed_boundaries" (
	"closed_boundary_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_resource_id" text NOT NULL,
	"purpose" text NOT NULL,
	"channel_resource_id" text NOT NULL,
	"market_resource_id" text,
	"storefront_resource_id" text,
	"effective_from" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_closed_boundaries_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","closed_boundary_id"),
	CONSTRAINT "assortment_closed_boundaries_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "assortment_closed_boundaries_subject_ck" CHECK ("subject_kind" in ('RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY') and "subject_resource_id" = btrim("subject_resource_id") and length("subject_resource_id") > 0),
	CONSTRAINT "assortment_closed_boundaries_purpose_ck" CHECK ("purpose" in ('VISIBILITY', 'PURCHASE')),
	CONSTRAINT "assortment_closed_boundaries_channel_ck" CHECK ("channel_resource_id" = btrim("channel_resource_id") and length("channel_resource_id") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_closed_boundaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_closed_boundary_end_facts" (
	"closed_boundary_end_fact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"closed_boundary_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_boundary_end_facts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","closed_boundary_end_fact_id"),
	CONSTRAINT "assortment_boundary_end_facts_boundary_uk" UNIQUE("tenant_id","legal_entity_id","closed_boundary_id"),
	CONSTRAINT "assortment_boundary_end_facts_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_closed_boundary_end_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_collection_revisions" (
	"collection_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"collection_kind" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"revision" integer NOT NULL,
	"member_count" integer NOT NULL,
	"completeness" text NOT NULL,
	"content_hash" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_collection_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","collection_revision_id"),
	CONSTRAINT "assortment_collection_revisions_aggregate_revision_uk" UNIQUE("tenant_id","legal_entity_id","collection_kind","aggregate_id","revision"),
	CONSTRAINT "assortment_collection_revisions_idempotency_uk" UNIQUE("tenant_id","legal_entity_id","idempotency_key"),
	CONSTRAINT "assortment_collection_revisions_kind_ck" CHECK ("collection_kind" = 'CLOSED_BOUNDARY_ADMISSION_SET'),
	CONSTRAINT "assortment_collection_revisions_purpose_ck" CHECK ("purpose" in ('VISIBILITY', 'PURCHASE')),
	CONSTRAINT "assortment_collection_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "assortment_collection_revisions_member_count_ck" CHECK ("member_count" >= 0),
	CONSTRAINT "assortment_collection_revisions_completeness_ck" CHECK ("completeness" = 'COMPLETE'),
	CONSTRAINT "assortment_collection_revisions_hash_ck" CHECK ("content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_collection_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_rule_retirement_facts" (
	"rule_retirement_fact_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"stable_rule_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_rule_retirement_facts_scope_id_uk" UNIQUE("tenant_id","rule_retirement_fact_id"),
	CONSTRAINT "assortment_rule_retirement_facts_rule_uk" UNIQUE("tenant_id","stable_rule_id"),
	CONSTRAINT "assortment_rule_retirement_facts_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "assortment_rule_retirement_facts_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_rule_retirement_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_rule_revisions" (
	"rule_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"stable_rule_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"purpose" text NOT NULL,
	"effect" text NOT NULL,
	"selector_kind" text NOT NULL,
	"selector_target_resource_id" text,
	"selector_target_resource_type" text,
	"semantic_fingerprint" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_rule_revisions_scope_id_uk" UNIQUE("tenant_id","rule_revision_id"),
	CONSTRAINT "assortment_rule_revisions_stable_number_uk" UNIQUE("tenant_id","stable_rule_id","revision_number"),
	CONSTRAINT "assortment_rule_revisions_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "assortment_rule_revisions_number_ck" CHECK ("revision_number" > 0),
	CONSTRAINT "assortment_rule_revisions_purpose_ck" CHECK ("purpose" in ('VISIBILITY', 'PURCHASE')),
	CONSTRAINT "assortment_rule_revisions_effect_ck" CHECK ("effect" in ('ALLOW', 'DENY')),
	CONSTRAINT "assortment_rule_revisions_selector_ck" CHECK ("selector_kind" in ('ALL', 'CATEGORY', 'PRODUCT', 'VARIANT', 'PACKAGE_OPTION') and (("selector_kind" = 'ALL' and "selector_target_resource_id" is null and "selector_target_resource_type" is null) or ("selector_kind" <> 'ALL' and "selector_target_resource_id" is not null and "selector_target_resource_type" is not null))),
	CONSTRAINT "assortment_rule_revisions_purpose_selector_ck" CHECK ("purpose" = 'PURCHASE' or "selector_kind" in ('ALL', 'CATEGORY', 'PRODUCT')),
	CONSTRAINT "assortment_rule_revisions_fingerprint_ck" CHECK ("semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assortment_rule_revisions_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_rule_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "assortment"."assortment_stable_rules" (
	"stable_rule_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"stable_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assortment_stable_rules_scope_id_uk" UNIQUE("tenant_id","stable_rule_id"),
	CONSTRAINT "assortment_stable_rules_code_uk" UNIQUE("tenant_id","stable_code"),
	CONSTRAINT "assortment_stable_rules_idempotency_uk" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "assortment_stable_rules_code_ck" CHECK ("stable_code" ~ '^[a-z][a-z0-9._-]{0,127}$'),
	CONSTRAINT "assortment_stable_rules_provenance_ck" CHECK ("provenance_ref" = btrim("provenance_ref") and length("provenance_ref") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "assortment"."assortment_stable_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "assortment_bindings_current_idx" ON "assortment"."assortment_applicability_bindings" ("tenant_id","legal_entity_id","binding_kind","channel_resource_id","market_resource_id","storefront_resource_id","effective_from");--> statement-breakpoint
CREATE INDEX "assortment_closed_boundaries_current_idx" ON "assortment"."assortment_closed_boundaries" ("tenant_id","legal_entity_id","subject_kind","subject_resource_id","purpose","channel_resource_id","market_resource_id","storefront_resource_id","effective_from");--> statement-breakpoint
CREATE INDEX "assortment_rule_revisions_current_idx" ON "assortment"."assortment_rule_revisions" ("tenant_id","stable_rule_id");--> statement-breakpoint
ALTER TABLE "assortment"."assortment_admission_set_entries" ADD CONSTRAINT "assortment_admission_entries_set_fk" FOREIGN KEY ("tenant_id","legal_entity_id","admission_set_id") REFERENCES "assortment"."assortment_admission_sets"("tenant_id","legal_entity_id","admission_set_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_admission_sets" ADD CONSTRAINT "assortment_admission_sets_boundary_fk" FOREIGN KEY ("tenant_id","legal_entity_id","closed_boundary_id") REFERENCES "assortment"."assortment_closed_boundaries"("tenant_id","legal_entity_id","closed_boundary_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_admission_sets" ADD CONSTRAINT "assortment_admission_sets_collection_fk" FOREIGN KEY ("tenant_id","legal_entity_id","collection_revision_id") REFERENCES "assortment"."assortment_collection_revisions"("tenant_id","legal_entity_id","collection_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_applicability_binding_end_facts" ADD CONSTRAINT "assortment_binding_end_facts_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","applicability_binding_id") REFERENCES "assortment"."assortment_applicability_bindings"("tenant_id","legal_entity_id","applicability_binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_applicability_bindings" ADD CONSTRAINT "assortment_bindings_rule_revision_fk" FOREIGN KEY ("tenant_id","rule_revision_id") REFERENCES "assortment"."assortment_rule_revisions"("tenant_id","rule_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_closed_boundary_end_facts" ADD CONSTRAINT "assortment_boundary_end_facts_boundary_fk" FOREIGN KEY ("tenant_id","legal_entity_id","closed_boundary_id") REFERENCES "assortment"."assortment_closed_boundaries"("tenant_id","legal_entity_id","closed_boundary_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_collection_revisions" ADD CONSTRAINT "assortment_collection_revisions_boundary_fk" FOREIGN KEY ("tenant_id","legal_entity_id","aggregate_id") REFERENCES "assortment"."assortment_closed_boundaries"("tenant_id","legal_entity_id","closed_boundary_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_rule_retirement_facts" ADD CONSTRAINT "assortment_rule_retirement_facts_rule_fk" FOREIGN KEY ("tenant_id","stable_rule_id") REFERENCES "assortment"."assortment_stable_rules"("tenant_id","stable_rule_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "assortment"."assortment_rule_revisions" ADD CONSTRAINT "assortment_rule_revisions_stable_rule_fk" FOREIGN KEY ("tenant_id","stable_rule_id") REFERENCES "assortment"."assortment_stable_rules"("tenant_id","stable_rule_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "assortment_admission_entries_scope_select" ON "assortment"."assortment_admission_set_entries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_admission_set_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_set_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_entries_scope_insert" ON "assortment"."assortment_admission_set_entries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_admission_set_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_set_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_entries_scope_update" ON "assortment"."assortment_admission_set_entries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_admission_set_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_set_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_admission_set_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_set_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_entries_scope_delete" ON "assortment"."assortment_admission_set_entries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_admission_set_entries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_set_entries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_sets_scope_select" ON "assortment"."assortment_admission_sets" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_admission_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_sets"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_sets_scope_insert" ON "assortment"."assortment_admission_sets" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_admission_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_sets"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_sets_scope_update" ON "assortment"."assortment_admission_sets" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_admission_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_sets"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_admission_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_sets"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_admission_sets_scope_delete" ON "assortment"."assortment_admission_sets" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_admission_sets"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_admission_sets"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_binding_end_facts_scope_select" ON "assortment"."assortment_applicability_binding_end_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_applicability_binding_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_binding_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_binding_end_facts_scope_insert" ON "assortment"."assortment_applicability_binding_end_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_applicability_binding_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_binding_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_binding_end_facts_scope_update" ON "assortment"."assortment_applicability_binding_end_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_applicability_binding_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_binding_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_applicability_binding_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_binding_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_binding_end_facts_scope_delete" ON "assortment"."assortment_applicability_binding_end_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_applicability_binding_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_binding_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_bindings_scope_select" ON "assortment"."assortment_applicability_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_applicability_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_bindings_scope_insert" ON "assortment"."assortment_applicability_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_applicability_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_bindings_scope_update" ON "assortment"."assortment_applicability_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_applicability_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_applicability_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_bindings_scope_delete" ON "assortment"."assortment_applicability_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_applicability_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_applicability_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_closed_boundaries_scope_select" ON "assortment"."assortment_closed_boundaries" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_closed_boundaries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundaries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_closed_boundaries_scope_insert" ON "assortment"."assortment_closed_boundaries" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_closed_boundaries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundaries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_closed_boundaries_scope_update" ON "assortment"."assortment_closed_boundaries" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_closed_boundaries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundaries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_closed_boundaries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundaries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_closed_boundaries_scope_delete" ON "assortment"."assortment_closed_boundaries" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_closed_boundaries"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundaries"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_boundary_end_facts_scope_select" ON "assortment"."assortment_closed_boundary_end_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_closed_boundary_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundary_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_boundary_end_facts_scope_insert" ON "assortment"."assortment_closed_boundary_end_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_closed_boundary_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundary_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_boundary_end_facts_scope_update" ON "assortment"."assortment_closed_boundary_end_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_closed_boundary_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundary_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_closed_boundary_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundary_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_boundary_end_facts_scope_delete" ON "assortment"."assortment_closed_boundary_end_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_closed_boundary_end_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_closed_boundary_end_facts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_collection_revisions_scope_select" ON "assortment"."assortment_collection_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_collection_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_collection_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_collection_revisions_scope_insert" ON "assortment"."assortment_collection_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_collection_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_collection_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_collection_revisions_scope_update" ON "assortment"."assortment_collection_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_collection_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_collection_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_collection_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_collection_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_collection_revisions_scope_delete" ON "assortment"."assortment_collection_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_collection_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "assortment"."assortment_collection_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_retirement_facts_scope_select" ON "assortment"."assortment_rule_retirement_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_rule_retirement_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_retirement_facts_scope_insert" ON "assortment"."assortment_rule_retirement_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_rule_retirement_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_retirement_facts_scope_update" ON "assortment"."assortment_rule_retirement_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_rule_retirement_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_rule_retirement_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_retirement_facts_scope_delete" ON "assortment"."assortment_rule_retirement_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_rule_retirement_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_revisions_scope_select" ON "assortment"."assortment_rule_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_revisions_scope_insert" ON "assortment"."assortment_rule_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_revisions_scope_update" ON "assortment"."assortment_rule_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_rule_revisions_scope_delete" ON "assortment"."assortment_rule_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_rule_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_stable_rules_scope_select" ON "assortment"."assortment_stable_rules" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("assortment"."assortment_stable_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_stable_rules_scope_insert" ON "assortment"."assortment_stable_rules" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("assortment"."assortment_stable_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_stable_rules_scope_update" ON "assortment"."assortment_stable_rules" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("assortment"."assortment_stable_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("assortment"."assortment_stable_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "assortment_stable_rules_scope_delete" ON "assortment"."assortment_stable_rules" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("assortment"."assortment_stable_rules"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);