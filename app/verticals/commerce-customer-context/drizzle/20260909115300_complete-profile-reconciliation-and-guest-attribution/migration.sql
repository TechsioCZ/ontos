CREATE TABLE "commerce_customer_context"."customer_profile_aliases" (
	"customer_profile_alias_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"alias_profile_id" uuid NOT NULL,
	"canonical_profile_id" uuid NOT NULL,
	"profile_reconciliation_case_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_profile_aliases_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_alias_id"),
	CONSTRAINT "ccc_profile_aliases_alias_uk" UNIQUE("tenant_id","legal_entity_id","alias_profile_id"),
	CONSTRAINT "ccc_profile_aliases_distinct_ck" CHECK ("alias_profile_id" <> "canonical_profile_id"),
	CONSTRAINT "ccc_profile_aliases_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."guest_retail_attributions" (
	"guest_retail_attribution_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"correlation_root" text NOT NULL,
	"guest_evidence_ref" text NOT NULL,
	"outcome" text NOT NULL,
	"party_resource_id" text,
	"retail_customer_profile_id" uuid,
	"reconciliation_ref" text,
	"requested_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_guest_attributions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","guest_retail_attribution_id"),
	CONSTRAINT "ccc_guest_attributions_correlation_uk" UNIQUE("tenant_id","legal_entity_id","correlation_root"),
	CONSTRAINT "ccc_guest_attributions_correlation_ck" CHECK ("correlation_root" = btrim("correlation_root") and length("correlation_root") > 0),
	CONSTRAINT "ccc_guest_attributions_evidence_ck" CHECK ("guest_evidence_ref" = btrim("guest_evidence_ref") and length("guest_evidence_ref") > 0),
	CONSTRAINT "ccc_guest_attributions_party_ck" CHECK ("party_resource_id" is null or ("party_resource_id" = btrim("party_resource_id") and length("party_resource_id") > 0)),
	CONSTRAINT "ccc_guest_attributions_reconciliation_ck" CHECK ("reconciliation_ref" is null or ("reconciliation_ref" = btrim("reconciliation_ref") and length("reconciliation_ref") > 0)),
	CONSTRAINT "ccc_guest_attributions_outcome_ck" CHECK ("outcome" in ('ATTRIBUTED', 'PARTY_UNRESOLVED', 'PARTY_AMBIGUOUS', 'PARTY_INVALID')),
	CONSTRAINT "ccc_guest_attributions_result_ck" CHECK (("outcome" = 'ATTRIBUTED' and "party_resource_id" is not null and "retail_customer_profile_id" is not null and "reconciliation_ref" is null) or ("outcome" = 'PARTY_AMBIGUOUS' and "party_resource_id" is null and "retail_customer_profile_id" is null and "reconciliation_ref" is not null) or ("outcome" in ('PARTY_UNRESOLVED', 'PARTY_INVALID') and "party_resource_id" is null and "retail_customer_profile_id" is null and "reconciliation_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."guest_retail_attributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."profile_reconciliation_case_members" (
	"profile_reconciliation_case_member_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"profile_reconciliation_case_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"member_position" integer NOT NULL,
	"observed_lifecycle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_reconciliation_members_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_member_id"),
	CONSTRAINT "ccc_reconciliation_members_profile_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_id","customer_profile_id"),
	CONSTRAINT "ccc_reconciliation_members_position_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_id","member_position"),
	CONSTRAINT "ccc_reconciliation_members_position_ck" CHECK ("member_position" >= 0),
	CONSTRAINT "ccc_reconciliation_members_lifecycle_ck" CHECK ("observed_lifecycle" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED'))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_case_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."retail_portal_profile_binding_history" (
	"retail_portal_profile_binding_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"retail_portal_profile_binding_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"from_lifecycle" text,
	"to_lifecycle" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"enrollment_evidence_ref" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_portal_binding_history_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","retail_portal_profile_binding_history_id"),
	CONSTRAINT "ccc_portal_binding_history_revision_uk" UNIQUE("tenant_id","legal_entity_id","retail_portal_profile_binding_id","revision"),
	CONSTRAINT "ccc_portal_binding_history_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_portal_binding_history_from_ck" CHECK ("from_lifecycle" is null or "from_lifecycle" in ('ACTIVE', 'REVOKED')),
	CONSTRAINT "ccc_portal_binding_history_to_ck" CHECK ("to_lifecycle" in ('ACTIVE', 'REVOKED')),
	CONSTRAINT "ccc_portal_binding_history_evidence_ck" CHECK ("enrollment_evidence_ref" = btrim("enrollment_evidence_ref") and length("enrollment_evidence_ref") > 0),
	CONSTRAINT "ccc_portal_binding_history_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_portal_bindings_current_profile_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_portal_bindings_current_auth_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "source_correlation_ref" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "target_subject" jsonb;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "owner_outcomes" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "last_processed_event_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "resulting_state" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "source_domain_event_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD COLUMN "enrollment_evidence_ref" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profiles" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $legacy_profile_reconciliation_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "commerce_customer_context"."profile_reconciliation_cases"
     WHERE "lifecycle"='DISMISSED'
        OR ("lifecycle"='RESOLVED' AND (
          "resolution_kind" IS DISTINCT FROM 'SELECT_CANONICAL'
          OR "canonical_profile_id" IS NULL
          OR "canonical_profile_id" NOT IN ("source_profile_id", "colliding_profile_id")
          OR "resolved_at" IS NULL))
  ) OR EXISTS (
    SELECT 1
      FROM "commerce_customer_context"."profile_reconciliation_cases" reconciliation
      JOIN "commerce_customer_context"."customer_profiles" source_profile
        ON source_profile."tenant_id"=reconciliation."tenant_id"
       AND source_profile."legal_entity_id"=reconciliation."legal_entity_id"
       AND source_profile."customer_profile_id"=reconciliation."source_profile_id"
      JOIN "commerce_customer_context"."customer_profiles" colliding_profile
        ON colliding_profile."tenant_id"=reconciliation."tenant_id"
       AND colliding_profile."legal_entity_id"=reconciliation."legal_entity_id"
       AND colliding_profile."customer_profile_id"=reconciliation."colliding_profile_id"
      LEFT JOIN "commerce_customer_context"."customer_profiles" canonical_profile
        ON canonical_profile."tenant_id"=reconciliation."tenant_id"
       AND canonical_profile."legal_entity_id"=reconciliation."legal_entity_id"
       AND canonical_profile."customer_profile_id"=reconciliation."canonical_profile_id"
     WHERE source_profile."profile_kind" IS DISTINCT FROM reconciliation."profile_kind"
        OR colliding_profile."profile_kind" IS DISTINCT FROM reconciliation."profile_kind"
        OR (reconciliation."canonical_profile_id" IS NOT NULL
          AND canonical_profile."profile_kind" IS DISTINCT FROM reconciliation."profile_kind")
  ) THEN
    RAISE EXCEPTION 'Legacy dismissed/non-canonical Profile reconciliations require explicit migration policy before the completion model can be installed';
  END IF;
END
$legacy_profile_reconciliation_preflight$;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" DROP CONSTRAINT "ccc_reconciliation_lifecycle_ck";
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" DROP CONSTRAINT "ccc_reconciliation_resolution_ck";--> statement-breakpoint
UPDATE "commerce_customer_context"."profile_reconciliation_cases"
SET "source_correlation_ref" = "merge_resource_id",
    "trigger" = CASE "profile_kind" WHEN 'RETAIL' THEN 'PARTY_ALIAS' ELSE 'COUNTERPARTY_ALIAS' END,
    "owner_outcomes" = CASE WHEN "lifecycle" IN ('OPEN','NEEDS_EVIDENCE')
      THEN '[{"owner":"PROFILE_LIFECYCLE","status":"PENDING"},{"owner":"CUSTOMER_GROUP_MEMBERSHIP","status":"PENDING"},{"owner":"PRICE_GROUP_ASSIGNMENT","status":"PENDING"},{"owner":"CURRENCY_PREFERENCE","status":"PENDING"},{"owner":"PAYMENT_TERMS","status":"PENDING"},{"owner":"ADDRESS_BOOK","status":"PENDING"},{"owner":"RETAIL_PORTAL_BINDING","status":"PENDING"},{"owner":"COUNTERPARTY_ACCESS","status":"PENDING"},{"owner":"PURCHASE_LIMITS","status":"PENDING"},{"owner":"APPROVAL","status":"PENDING"},{"owner":"CONNECTOR_CORRELATION","status":"PENDING"}]'::jsonb
      ELSE '[]'::jsonb END,
    "resulting_state" = CASE WHEN "lifecycle"='RESOLVED' THEN (
      SELECT profile."lifecycle" FROM "commerce_customer_context"."customer_profiles" profile
       WHERE profile."tenant_id"="profile_reconciliation_cases"."tenant_id"
         AND profile."legal_entity_id"="profile_reconciliation_cases"."legal_entity_id"
         AND profile."customer_profile_id"="profile_reconciliation_cases"."canonical_profile_id"
    ) ELSE NULL END,
    "lifecycle" = CASE "lifecycle" WHEN 'NEEDS_EVIDENCE' THEN 'BLOCKED' WHEN 'RESOLVED' THEN 'COMPLETED' ELSE "lifecycle" END,
    "target_subject" = CASE "profile_kind"
      WHEN 'RETAIL' THEN jsonb_build_object(
        'kind','RETAIL',
        'partyRef',jsonb_build_object('moduleId','party.registry','resourceId',"canonical_party_resource_id",'resourceType','party.registry.party','tenantId',"tenant_id"),
        'sellingLegalEntityRef',jsonb_build_object('moduleId','core.identity','resourceId',"legal_entity_id",'resourceType','core.identity.legal-entity','tenantId',"tenant_id")
      )
      ELSE jsonb_build_object(
        'kind','COUNTERPARTY',
        'counterpartyRef',jsonb_build_object('moduleId','party.registry','resourceId',"canonical_party_resource_id",'resourceType','party.registry.counterparty','tenantId',"tenant_id")
      )
    END;--> statement-breakpoint
UPDATE "commerce_customer_context"."retail_portal_profile_bindings"
SET "enrollment_evidence_ref" = 'migration:action-invocation:' || "action_invocation_id"::text;--> statement-breakpoint
INSERT INTO "commerce_customer_context"."retail_portal_profile_binding_history" (
  "tenant_id", "legal_entity_id", "retail_portal_profile_binding_id", "revision",
  "from_lifecycle", "to_lifecycle", "effective_at", "enrollment_evidence_ref",
  "action_invocation_id", "actor_principal_id", "reason"
)
SELECT binding."tenant_id", binding."legal_entity_id",
       binding."retail_portal_profile_binding_id", binding."revision",
       NULL, binding."lifecycle", binding."recorded_at", binding."enrollment_evidence_ref",
       binding."action_invocation_id", binding."actor_principal_id", binding."reason"
  FROM "commerce_customer_context"."retail_portal_profile_bindings" binding;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ALTER COLUMN "source_correlation_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ALTER COLUMN "trigger" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ALTER COLUMN "target_subject" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ALTER COLUMN "enrollment_evidence_ref" SET NOT NULL;--> statement-breakpoint
INSERT INTO "commerce_customer_context"."profile_reconciliation_case_members" (
  "tenant_id", "legal_entity_id", "profile_reconciliation_case_id",
  "customer_profile_id", "member_position", "observed_lifecycle"
)
SELECT reconciliation."tenant_id", reconciliation."legal_entity_id",
       reconciliation."profile_reconciliation_case_id", member."profile_id",
       member."member_position", profile."lifecycle"
  FROM "commerce_customer_context"."profile_reconciliation_cases" reconciliation
 CROSS JOIN LATERAL (VALUES
   (reconciliation."source_profile_id", 0),
   (reconciliation."colliding_profile_id", 1)
 ) member("profile_id", "member_position")
  JOIN "commerce_customer_context"."customer_profiles" profile
    ON profile."tenant_id"=reconciliation."tenant_id"
   AND profile."legal_entity_id"=reconciliation."legal_entity_id"
   AND profile."customer_profile_id"=member."profile_id";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profiles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ALTER COLUMN "action_invocation_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_portal_bindings_current_profile_principal_uk" ON "commerce_customer_context"."retail_portal_profile_bindings" ("tenant_id","legal_entity_id","retail_customer_profile_id","principal_id") WHERE "lifecycle" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_aliases" ADD CONSTRAINT "ccc_profile_aliases_alias_fk" FOREIGN KEY ("tenant_id","legal_entity_id","alias_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_aliases" ADD CONSTRAINT "ccc_profile_aliases_canonical_fk" FOREIGN KEY ("tenant_id","legal_entity_id","canonical_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_aliases" ADD CONSTRAINT "ccc_profile_aliases_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","profile_reconciliation_case_id") REFERENCES "commerce_customer_context"."profile_reconciliation_cases"("tenant_id","legal_entity_id","profile_reconciliation_case_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."guest_retail_attributions" ADD CONSTRAINT "ccc_guest_attributions_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","retail_customer_profile_id") REFERENCES "commerce_customer_context"."retail_customer_profiles"("tenant_id","legal_entity_id","retail_customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_case_members" ADD CONSTRAINT "ccc_reconciliation_members_case_fk" FOREIGN KEY ("tenant_id","legal_entity_id","profile_reconciliation_case_id") REFERENCES "commerce_customer_context"."profile_reconciliation_cases"("tenant_id","legal_entity_id","profile_reconciliation_case_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_case_members" ADD CONSTRAINT "ccc_reconciliation_members_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_history" ADD CONSTRAINT "ccc_portal_binding_history_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","retail_portal_profile_binding_id") REFERENCES "commerce_customer_context"."retail_portal_profile_bindings"("tenant_id","legal_entity_id","retail_portal_profile_binding_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_correlation_ck" CHECK ("source_correlation_ref" = btrim("source_correlation_ref") and length("source_correlation_ref") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_trigger_ck" CHECK ("trigger" in ('PARTY_ALIAS', 'COUNTERPARTY_ALIAS', 'CREATE_COLLISION', 'IMPORT_CORRELATION'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_target_subject_ck" CHECK (jsonb_typeof("target_subject") = 'object');--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_owner_outcomes_ck" CHECK (jsonb_typeof("owner_outcomes") = 'array');--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_event_version_ck" CHECK ("last_processed_event_version" >= 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_causation_ck" CHECK (("action_invocation_id" is not null and "source_domain_event_id" is null and "source_message_id" is null) or ("action_invocation_id" is null and "source_domain_event_id" is not null and "source_message_id" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD CONSTRAINT "ccc_portal_bindings_enrollment_evidence_ck" CHECK ("enrollment_evidence_ref" = btrim("enrollment_evidence_ref") and length("enrollment_evidence_ref") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_lifecycle_ck" CHECK ("lifecycle" in ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE', 'COMPLETED'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_resolution_ck" CHECK (("lifecycle" in ('OPEN', 'BLOCKED', 'READY_TO_COMPLETE') and "resolution_kind" is null and "canonical_profile_id" is null and "resulting_state" is null and "resolved_at" is null) or ("lifecycle" = 'COMPLETED' and "resolution_kind" = 'SELECT_CANONICAL' and "canonical_profile_id" is not null and "resulting_state" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED') and "resolved_at" is not null));--> statement-breakpoint
CREATE POLICY "ccc_profile_aliases_scope_select" ON "commerce_customer_context"."customer_profile_aliases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_aliases_scope_insert" ON "commerce_customer_context"."customer_profile_aliases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_aliases_scope_update" ON "commerce_customer_context"."customer_profile_aliases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_aliases_scope_delete" ON "commerce_customer_context"."customer_profile_aliases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_aliases_scope_owner_routine" ON "commerce_customer_context"."customer_profile_aliases" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_aliases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_guest_attributions_scope_select" ON "commerce_customer_context"."guest_retail_attributions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_guest_attributions_scope_insert" ON "commerce_customer_context"."guest_retail_attributions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_guest_attributions_scope_update" ON "commerce_customer_context"."guest_retail_attributions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_guest_attributions_scope_delete" ON "commerce_customer_context"."guest_retail_attributions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_guest_attributions_scope_owner_routine" ON "commerce_customer_context"."guest_retail_attributions" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."guest_retail_attributions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."guest_retail_attributions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_members_scope_select" ON "commerce_customer_context"."profile_reconciliation_case_members" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_members_scope_insert" ON "commerce_customer_context"."profile_reconciliation_case_members" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_members_scope_update" ON "commerce_customer_context"."profile_reconciliation_case_members" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_members_scope_delete" ON "commerce_customer_context"."profile_reconciliation_case_members" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_members_scope_owner_routine" ON "commerce_customer_context"."profile_reconciliation_case_members" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."profile_reconciliation_case_members"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_case_members"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_history_scope_select" ON "commerce_customer_context"."retail_portal_profile_binding_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_history_scope_insert" ON "commerce_customer_context"."retail_portal_profile_binding_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_history_scope_update" ON "commerce_customer_context"."retail_portal_profile_binding_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_history_scope_delete" ON "commerce_customer_context"."retail_portal_profile_binding_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_binding_history_scope_owner_routine" ON "commerce_customer_context"."retail_portal_profile_binding_history" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."retail_portal_profile_binding_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_binding_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);

-- Generated RLS enables are not sufficient for SECURITY DEFINER-owned tables.
-- FORCE keeps owner routines inside the verified transaction scope as well.
ALTER TABLE "commerce_customer_context"."customer_profile_aliases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."guest_retail_attributions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."profile_reconciliation_case_members" FORCE ROW LEVEL SECURITY;
ALTER TABLE "commerce_customer_context"."retail_portal_profile_binding_history" FORCE ROW LEVEL SECURITY;

-- These rows are durable evidence. Corrections are represented by newer rows/state,
-- never by rewriting or deleting the evidence that was observed.
CREATE TRIGGER "ccc_profile_aliases_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."customer_profile_aliases"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();

CREATE TRIGGER "ccc_guest_attributions_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."guest_retail_attributions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();

CREATE TRIGGER "ccc_reconciliation_members_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."profile_reconciliation_case_members"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();

CREATE TRIGGER "ccc_portal_binding_history_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."retail_portal_profile_binding_history"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();

-- Runtime access is routine-only. Revoke again after introducing new tables because
-- database default privileges are intentionally not trusted as an authorization boundary.
REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";

DO $profile_completion_privileges$
DECLARE
  protected_relation text;
BEGIN
  FOREACH protected_relation IN ARRAY ARRAY[
    'commerce_customer_context.customer_profile_aliases',
    'commerce_customer_context.guest_retail_attributions',
    'commerce_customer_context.profile_reconciliation_case_members',
    'commerce_customer_context.retail_portal_profile_binding_history'
  ] LOOP
    IF has_table_privilege('ontos_runtime', protected_relation, 'SELECT')
       OR has_table_privilege('ontos_runtime', protected_relation, 'INSERT')
       OR has_table_privilege('ontos_runtime', protected_relation, 'UPDATE')
       OR has_table_privilege('ontos_runtime', protected_relation, 'DELETE')
       OR has_table_privilege('public', protected_relation, 'SELECT')
       OR has_table_privilege('public', protected_relation, 'INSERT')
       OR has_table_privilege('public', protected_relation, 'UPDATE')
       OR has_table_privilege('public', protected_relation, 'DELETE') THEN
      RAISE EXCEPTION 'Direct runtime/public privilege leaked on %', protected_relation;
    END IF;
  END LOOP;
END
$profile_completion_privileges$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."transition_profile"(uuid,uuid,uuid,text,text,integer,text,timestamptz,text,boolean,boolean,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."mutate_retail_portal_binding"(uuid,uuid,uuid,uuid,uuid,text,text,integer,text,timestamptz,text,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_customer_profile"(uuid,uuid,uuid,text) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_profile_trading_gate"(uuid,uuid,uuid,text) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_retail_portal_binding"(uuid,uuid,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."resolve_retail_principal"(uuid,uuid,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."read_guest_attribution"(uuid,uuid,text) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."resolve_profile_reconciliation"(uuid,uuid,uuid,uuid,integer,bigint,jsonb,text,timestamptz,text,uuid,uuid) TO "ontos_runtime";
GRANT EXECUTE ON FUNCTION "commerce_customer_context"."record_profile_reconciliation_owner_outcome"(uuid,uuid,uuid,uuid,text,text,text,text,integer,bigint,text,timestamptz,text,uuid,uuid) TO "ontos_runtime";
