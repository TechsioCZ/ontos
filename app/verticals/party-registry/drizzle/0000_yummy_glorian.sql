CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE SCHEMA "party";
--> statement-breakpoint
CREATE TABLE "party"."counterparties" (
	"counterparty_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"creation_reason" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"source_record_refs" jsonb NOT NULL,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "party_counterparties_tenant_id_uk" UNIQUE("tenant_id","counterparty_id"),
	CONSTRAINT "party_counterparties_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_id"),
	CONSTRAINT "party_counterparties_projection_source_uk" UNIQUE("tenant_id","counterparty_id","legal_entity_id","party_id"),
	CONSTRAINT "party_counterparties_context_uk" UNIQUE("tenant_id","party_id","legal_entity_id"),
	CONSTRAINT "party_counterparties_creation_reason_ck" CHECK ("party"."counterparties"."creation_reason" = btrim("party"."counterparties"."creation_reason") and length("party"."counterparties"."creation_reason") > 0),
	CONSTRAINT "party_counterparties_evidence_ck" CHECK (jsonb_typeof("party"."counterparties"."evidence_refs") = 'array' and jsonb_array_length("party"."counterparties"."evidence_refs") between 1 and 32 and jsonb_typeof("party"."counterparties"."source_record_refs") = 'array' and jsonb_array_length("party"."counterparties"."source_record_refs") <= 32)
);
--> statement-breakpoint
ALTER TABLE "party"."counterparties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."counterparty_admin_read_models" (
	"counterparty_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"stored_party_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "party_counterparty_admin_models_tenant_id_uk" UNIQUE("tenant_id","counterparty_id")
);
--> statement-breakpoint
ALTER TABLE "party"."counterparty_admin_read_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."counterparty_role_admin_read_models" (
	"role_period_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"role_type" text NOT NULL,
	"add_reason" text NOT NULL,
	"add_evidence_refs" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"end_reason" text,
	"end_provenance_source" text,
	"end_provenance_method" text,
	"end_evidence_refs" jsonb,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	CONSTRAINT "party_counterparty_role_admin_models_tenant_id_uk" UNIQUE("tenant_id","role_period_id"),
	CONSTRAINT "party_counterparty_role_admin_models_type_ck" CHECK ("party"."counterparty_role_admin_read_models"."role_type" in ('CUSTOMER', 'SUPPLIER')),
	CONSTRAINT "party_counterparty_role_admin_models_state_ck" CHECK ("party"."counterparty_role_admin_read_models"."state" in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED')),
	CONSTRAINT "party_counterparty_role_admin_models_interval_ck" CHECK ("party"."counterparty_role_admin_read_models"."valid_to" is null or "party"."counterparty_role_admin_read_models"."valid_to" >= "party"."counterparty_role_admin_read_models"."valid_from"),
	CONSTRAINT "party_counterparty_role_admin_models_add_evidence_ck" CHECK ("party"."counterparty_role_admin_read_models"."add_reason" = btrim("party"."counterparty_role_admin_read_models"."add_reason") and length("party"."counterparty_role_admin_read_models"."add_reason") > 0 and jsonb_typeof("party"."counterparty_role_admin_read_models"."add_evidence_refs") = 'array' and jsonb_array_length("party"."counterparty_role_admin_read_models"."add_evidence_refs") between 1 and 32),
	CONSTRAINT "party_counterparty_role_admin_models_end_evidence_ck" CHECK (("party"."counterparty_role_admin_read_models"."valid_to" is null and "party"."counterparty_role_admin_read_models"."end_reason" is null and "party"."counterparty_role_admin_read_models"."end_provenance_source" is null and "party"."counterparty_role_admin_read_models"."end_provenance_method" is null and "party"."counterparty_role_admin_read_models"."end_evidence_refs" is null) or ("party"."counterparty_role_admin_read_models"."valid_to" is not null and length(btrim("party"."counterparty_role_admin_read_models"."end_reason")) > 0 and length(btrim("party"."counterparty_role_admin_read_models"."end_provenance_source")) > 0 and length(btrim("party"."counterparty_role_admin_read_models"."end_provenance_method")) > 0 and jsonb_typeof("party"."counterparty_role_admin_read_models"."end_evidence_refs") = 'array' and jsonb_array_length("party"."counterparty_role_admin_read_models"."end_evidence_refs") between 1 and 32))
);
--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_admin_read_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."counterparty_role_periods" (
	"role_period_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"role_type" text NOT NULL,
	"add_reason" text NOT NULL,
	"add_evidence_refs" jsonb NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"end_reason" text,
	"end_provenance_source" text,
	"end_provenance_method" text,
	"end_evidence_refs" jsonb,
	"ended_by_action_invocation_id" uuid,
	"ended_by_principal_id" uuid,
	"ended_recorded_at" timestamp with time zone,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	CONSTRAINT "party_counterparty_role_periods_tenant_id_uk" UNIQUE("tenant_id","role_period_id"),
	CONSTRAINT "party_counterparty_role_periods_projection_source_uk" UNIQUE("tenant_id","counterparty_id","role_period_id"),
	CONSTRAINT "party_counterparty_role_periods_type_ck" CHECK ("party"."counterparty_role_periods"."role_type" in ('CUSTOMER', 'SUPPLIER')),
	CONSTRAINT "party_counterparty_role_periods_interval_ck" CHECK ("party"."counterparty_role_periods"."valid_to" is null or "party"."counterparty_role_periods"."valid_to" >= "party"."counterparty_role_periods"."valid_from"),
	CONSTRAINT "party_counterparty_role_periods_state_ck" CHECK ("party"."counterparty_role_periods"."state" in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and ("party"."counterparty_role_periods"."state" = 'ACTIVE' or not "party"."counterparty_role_periods"."is_current")),
	CONSTRAINT "party_counterparty_role_periods_add_evidence_ck" CHECK ("party"."counterparty_role_periods"."add_reason" = btrim("party"."counterparty_role_periods"."add_reason") and length("party"."counterparty_role_periods"."add_reason") > 0 and jsonb_typeof("party"."counterparty_role_periods"."add_evidence_refs") = 'array' and jsonb_array_length("party"."counterparty_role_periods"."add_evidence_refs") between 1 and 32),
	CONSTRAINT "party_counterparty_role_periods_end_evidence_ck" CHECK ((("party"."counterparty_role_periods"."state" = 'ACTIVE' and (("party"."counterparty_role_periods"."valid_to" is null and "party"."counterparty_role_periods"."end_reason" is null and "party"."counterparty_role_periods"."end_evidence_refs" is null and "party"."counterparty_role_periods"."ended_by_action_invocation_id" is null and "party"."counterparty_role_periods"."ended_by_principal_id" is null and "party"."counterparty_role_periods"."ended_recorded_at" is null) or ("party"."counterparty_role_periods"."valid_to" is not null and length(btrim("party"."counterparty_role_periods"."end_reason")) > 0 and jsonb_typeof("party"."counterparty_role_periods"."end_evidence_refs") = 'array' and jsonb_array_length("party"."counterparty_role_periods"."end_evidence_refs") between 1 and 32 and "party"."counterparty_role_periods"."ended_by_action_invocation_id" is not null and "party"."counterparty_role_periods"."ended_by_principal_id" is not null and "party"."counterparty_role_periods"."ended_recorded_at" is not null))) or ("party"."counterparty_role_periods"."state" = 'ENDED' and "party"."counterparty_role_periods"."valid_to" is not null and length(btrim("party"."counterparty_role_periods"."end_reason")) > 0 and jsonb_typeof("party"."counterparty_role_periods"."end_evidence_refs") = 'array' and jsonb_array_length("party"."counterparty_role_periods"."end_evidence_refs") between 1 and 32 and "party"."counterparty_role_periods"."ended_by_action_invocation_id" is not null and "party"."counterparty_role_periods"."ended_by_principal_id" is not null and "party"."counterparty_role_periods"."ended_recorded_at" is not null) or ("party"."counterparty_role_periods"."state" in ('SUPERSEDED', 'RETRACTED', 'DISPUTED'))) and (("party"."counterparty_role_periods"."valid_to" is null and "party"."counterparty_role_periods"."end_provenance_source" is null and "party"."counterparty_role_periods"."end_provenance_method" is null) or ("party"."counterparty_role_periods"."valid_to" is not null and "party"."counterparty_role_periods"."end_provenance_source" = btrim("party"."counterparty_role_periods"."end_provenance_source") and length("party"."counterparty_role_periods"."end_provenance_source") > 0 and "party"."counterparty_role_periods"."end_provenance_method" = btrim("party"."counterparty_role_periods"."end_provenance_method") and length("party"."counterparty_role_periods"."end_provenance_method") > 0)))
);
--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."duplicate_candidate_case_parties" (
	"candidate_case_party_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_case_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"evidence_explanation" jsonb NOT NULL,
	CONSTRAINT "party_case_parties_tenant_id_uk" UNIQUE("tenant_id","candidate_case_party_id"),
	CONSTRAINT "party_case_parties_candidate_party_uk" UNIQUE("tenant_id","candidate_case_id","party_id"),
	CONSTRAINT "party_case_parties_rank_ck" CHECK ("party"."duplicate_candidate_case_parties"."rank" > 0)
);
--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_case_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."duplicate_candidate_cases" (
	"candidate_case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_fingerprint" text NOT NULL,
	"evaluation_fingerprint" text NOT NULL,
	"prior_candidate_case_id" uuid,
	"candidate_snapshot" jsonb NOT NULL,
	"evaluated_evidence" jsonb NOT NULL,
	"match_rule_version" text NOT NULL,
	"lifecycle_state" text DEFAULT 'OPEN' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"assigned_principal_id" uuid,
	"resolution_outcome" text,
	"selected_party_id" uuid,
	"resolution_action_invocation_id" uuid,
	"resolution_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_duplicate_cases_tenant_id_uk" UNIQUE("tenant_id","candidate_case_id"),
	CONSTRAINT "party_duplicate_cases_prior_case_ck" CHECK ("party"."duplicate_candidate_cases"."prior_candidate_case_id" is null or "party"."duplicate_candidate_cases"."prior_candidate_case_id" <> "party"."duplicate_candidate_cases"."candidate_case_id"),
	CONSTRAINT "party_duplicate_cases_evaluation_fingerprint_ck" CHECK ("party"."duplicate_candidate_cases"."evaluation_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "party_duplicate_cases_fingerprint_ck" CHECK ("party"."duplicate_candidate_cases"."candidate_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "party_duplicate_cases_snapshot_ck" CHECK (coalesce(jsonb_typeof("party"."duplicate_candidate_cases"."candidate_snapshot"), '') = 'object' and coalesce(jsonb_typeof("party"."duplicate_candidate_cases"."candidate_snapshot"->'names'), '') = 'array' and jsonb_array_length("party"."duplicate_candidate_cases"."candidate_snapshot"->'names') <= 32 and coalesce(jsonb_typeof("party"."duplicate_candidate_cases"."candidate_snapshot"->'provenance'), '') = 'object' and coalesce(length(btrim("party"."duplicate_candidate_cases"."candidate_snapshot"->'provenance'->>'source')), 0) between 1 and 500 and coalesce(length(btrim("party"."duplicate_candidate_cases"."candidate_snapshot"->'provenance'->>'method')), 0) between 1 and 500 and coalesce("party"."duplicate_candidate_cases"."candidate_snapshot"->>'validFrom', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$'),
	CONSTRAINT "party_duplicate_cases_revision_ck" CHECK ("party"."duplicate_candidate_cases"."revision" > 0),
	CONSTRAINT "party_duplicate_cases_lifecycle_ck" CHECK ("party"."duplicate_candidate_cases"."lifecycle_state" in ('OPEN', 'NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED')),
	CONSTRAINT "party_duplicate_cases_resolution_ck" CHECK ("party"."duplicate_candidate_cases"."resolution_outcome" is null or "party"."duplicate_candidate_cases"."resolution_outcome" in ('MATCH_EXISTING', 'CREATE_NEW', 'CORRECT_CLAIM_AND_MATCH', 'NEEDS_EVIDENCE', 'DISMISSED_AS_NON_SUBJECT', 'CONFIRMED_DUPLICATE_PARTIES'))
);
--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."parties" (
	"party_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"current_type" text NOT NULL,
	"current_display_name" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "party_parties_tenant_id_uk" UNIQUE("tenant_id","party_id"),
	CONSTRAINT "party_parties_type_ck" CHECK ("party"."parties"."current_type" in ('PERSON', 'ORGANIZATION', 'UNRESOLVED')),
	CONSTRAINT "party_parties_display_name_ck" CHECK ("party"."parties"."current_display_name" is null or ("party"."parties"."current_display_name" = btrim("party"."parties"."current_display_name") and length("party"."parties"."current_display_name") > 0)),
	CONSTRAINT "party_parties_revision_ck" CHECK ("party"."parties"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "party"."parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_aliases" (
	"party_alias_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"alias_party_id" uuid NOT NULL,
	"canonical_party_id" uuid NOT NULL,
	"merge_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_aliases_tenant_id_uk" UNIQUE("tenant_id","party_alias_id"),
	CONSTRAINT "party_aliases_alias_uk" UNIQUE("tenant_id","alias_party_id"),
	CONSTRAINT "party_aliases_not_self_ck" CHECK ("party"."party_aliases"."alias_party_id" <> "party"."party_aliases"."canonical_party_id")
);
--> statement-breakpoint
ALTER TABLE "party"."party_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_contact_point_purposes" (
	"contact_point_purpose_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"contact_point_id" uuid NOT NULL,
	"purpose_key" text NOT NULL,
	"registry_context" text DEFAULT 'GENERAL' NOT NULL,
	"jurisdiction" text DEFAULT 'ZZ' NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"end_reason" text,
	"end_provenance_source" text,
	"end_provenance_method" text,
	"end_evidence_refs" jsonb,
	"ended_by_action_invocation_id" uuid,
	"ended_by_principal_id" uuid,
	"ended_recorded_at" timestamp with time zone,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"external_evidence" jsonb,
	"provenance_authoritative" boolean DEFAULT false NOT NULL,
	"evidence_reference" text,
	"verification_state" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verification_method" text,
	"verifier_reference" text,
	"verified_by_principal_id" uuid,
	"verified_at" timestamp with time zone,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "party_contact_point_purposes_tenant_id_uk" UNIQUE("tenant_id","contact_point_purpose_id"),
	CONSTRAINT "party_contact_point_purposes_key_ck" CHECK ("party"."party_contact_point_purposes"."purpose_key" in ('REGISTERED', 'BILLING', 'DELIVERY', 'CORRESPONDENCE')),
	CONSTRAINT "party_contact_point_purposes_registry_ck" CHECK (("party"."party_contact_point_purposes"."purpose_key" <> 'REGISTERED') or ("party"."party_contact_point_purposes"."registry_context" <> 'GENERAL' and "party"."party_contact_point_purposes"."jurisdiction" ~ '^[A-Z]{2}$' and "party"."party_contact_point_purposes"."jurisdiction" <> 'ZZ')),
	CONSTRAINT "party_contact_point_purposes_interval_ck" CHECK ("party"."party_contact_point_purposes"."valid_to" is null or "party"."party_contact_point_purposes"."valid_to" >= "party"."party_contact_point_purposes"."valid_from"),
	CONSTRAINT "party_contact_point_purposes_state_ck" CHECK ("party"."party_contact_point_purposes"."state" in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and (("party"."party_contact_point_purposes"."state" = 'ACTIVE' and "party"."party_contact_point_purposes"."is_current") or ("party"."party_contact_point_purposes"."state" <> 'ACTIVE' and not "party"."party_contact_point_purposes"."is_current"))),
	CONSTRAINT "party_contact_point_purposes_end_evidence_ck" CHECK (("party"."party_contact_point_purposes"."valid_to" is null and "party"."party_contact_point_purposes"."end_reason" is null and "party"."party_contact_point_purposes"."end_provenance_source" is null and "party"."party_contact_point_purposes"."end_provenance_method" is null and "party"."party_contact_point_purposes"."end_evidence_refs" is null and "party"."party_contact_point_purposes"."ended_by_action_invocation_id" is null and "party"."party_contact_point_purposes"."ended_by_principal_id" is null and "party"."party_contact_point_purposes"."ended_recorded_at" is null) or ("party"."party_contact_point_purposes"."valid_to" is not null and "party"."party_contact_point_purposes"."end_reason" = btrim("party"."party_contact_point_purposes"."end_reason") and length("party"."party_contact_point_purposes"."end_reason") > 0 and "party"."party_contact_point_purposes"."end_provenance_source" = btrim("party"."party_contact_point_purposes"."end_provenance_source") and length("party"."party_contact_point_purposes"."end_provenance_source") > 0 and "party"."party_contact_point_purposes"."end_provenance_method" = btrim("party"."party_contact_point_purposes"."end_provenance_method") and length("party"."party_contact_point_purposes"."end_provenance_method") > 0 and jsonb_typeof("party"."party_contact_point_purposes"."end_evidence_refs") = 'array' and jsonb_array_length("party"."party_contact_point_purposes"."end_evidence_refs") <= 32 and "party"."party_contact_point_purposes"."ended_by_action_invocation_id" is not null and "party"."party_contact_point_purposes"."ended_by_principal_id" is not null and "party"."party_contact_point_purposes"."ended_recorded_at" is not null and "party"."party_contact_point_purposes"."ended_recorded_at" >= "party"."party_contact_point_purposes"."recorded_at")),
	CONSTRAINT "party_contact_point_purposes_verification_ck" CHECK ("party"."party_contact_point_purposes"."verification_state" in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and ("party"."party_contact_point_purposes"."verification_state" <> 'VERIFIED' or ("party"."party_contact_point_purposes"."verified_at" is not null and length(btrim("party"."party_contact_point_purposes"."verification_method")) > 0 and length(btrim("party"."party_contact_point_purposes"."verifier_reference")) > 0))),
	CONSTRAINT "party_contact_point_purposes_revision_ck" CHECK ("party"."party_contact_point_purposes"."revision" > 0),
	CONSTRAINT "party_contact_point_purposes_external_evidence_ck" CHECK ("party"."party_contact_point_purposes"."external_evidence" is null or coalesce((jsonb_typeof("party"."party_contact_point_purposes"."external_evidence") = 'object' and octet_length("party"."party_contact_point_purposes"."external_evidence"::text) <= 4096 and "party"."party_contact_point_purposes"."external_evidence" ?& array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] and "party"."party_contact_point_purposes"."external_evidence" - array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] = '{}'::jsonb and "party"."party_contact_point_purposes"."external_evidence"->>'provider' = 'ares' and "party"."party_contact_point_purposes"."external_evidence"->>'authorityPolicyKey' = 'party_registry.ares_enrichment' and "party"."party_contact_point_purposes"."external_evidence"->>'authorityPolicyVersion' = '1' and coalesce("party"."party_contact_point_purposes"."external_evidence"->>'queryIco', '') ~ '^[0-9]{8}$' and coalesce(length("party"."party_contact_point_purposes"."external_evidence"->>'evidenceRef'), 0) between 1 and 200 and "party"."party_contact_point_purposes"."external_evidence"->>'fact' in ('BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS', 'PARTY_CANDIDATE') and "party"."party_contact_point_purposes"."external_evidence"->>'outcome' in ('PREFILL_ONLY', 'APPLY_ENRICHMENT', 'NO_CHANGE', 'NEEDS_CONFIRMATION', 'CORRECTION_CANDIDATE', 'IDENTITY_AMBIGUITY') and coalesce("party"."party_contact_point_purposes"."external_evidence"->>'reasonCode', '') ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' and length("party"."party_contact_point_purposes"."external_evidence"->>'reasonCode') <= 100 and jsonb_typeof("party"."party_contact_point_purposes"."external_evidence"->'cacheAgeSeconds') = 'number' and coalesce("party"."party_contact_point_purposes"."external_evidence"->>'cacheAgeSeconds', '') ~ '^[0-9]+$' and coalesce("party"."party_contact_point_purposes"."external_evidence"->>'observedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_contact_point_purposes"."external_evidence"->>'servedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_contact_point_purposes"."external_evidence"->>'decidedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and ("party"."party_contact_point_purposes"."external_evidence"->'providerChangedOn' = 'null'::jsonb or coalesce("party"."party_contact_point_purposes"."external_evidence"->>'providerChangedOn', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and ("party"."party_contact_point_purposes"."external_evidence"->'providerRecordRef' = 'null'::jsonb or (jsonb_typeof("party"."party_contact_point_purposes"."external_evidence"->'providerRecordRef') = 'string' and length("party"."party_contact_point_purposes"."external_evidence"->>'providerRecordRef') between 1 and 200))), false))
);
--> statement-breakpoint
ALTER TABLE "party"."party_contact_point_purposes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_contact_points" (
	"contact_point_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"contact_point_type" text NOT NULL,
	"display_value" text,
	"normalized_value" text,
	"normalization_version" text,
	"phone_country_code" text,
	"phone_extension" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"postal_code" text,
	"region" text,
	"country_code" text,
	"privacy_classification" text NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"end_reason" text,
	"end_provenance_source" text,
	"end_provenance_method" text,
	"end_evidence_refs" jsonb,
	"ended_by_action_invocation_id" uuid,
	"ended_by_principal_id" uuid,
	"ended_recorded_at" timestamp with time zone,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"external_evidence" jsonb,
	"provenance_authoritative" boolean DEFAULT false NOT NULL,
	"evidence_reference" text,
	"additional_evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_state" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verification_method" text,
	"verifier_reference" text,
	"verified_by_principal_id" uuid,
	"verified_at" timestamp with time zone,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"supersedes_contact_point_id" uuid,
	"retracts_contact_point_id" uuid,
	CONSTRAINT "party_contact_points_tenant_id_uk" UNIQUE("tenant_id","contact_point_id"),
	CONSTRAINT "party_contact_points_tenant_party_id_uk" UNIQUE("tenant_id","party_id","contact_point_id"),
	CONSTRAINT "party_contact_points_type_ck" CHECK ("party"."party_contact_points"."contact_point_type" in ('EMAIL', 'PHONE', 'ADDRESS')),
	CONSTRAINT "party_contact_points_shape_ck" CHECK (("party"."party_contact_points"."contact_point_type" = 'EMAIL' and length(btrim("party"."party_contact_points"."display_value")) > 0 and length(btrim("party"."party_contact_points"."normalized_value")) > 0 and length(btrim("party"."party_contact_points"."normalization_version")) > 0 and "party"."party_contact_points"."phone_country_code" is null and "party"."party_contact_points"."phone_extension" is null and "party"."party_contact_points"."address_line_1" is null and "party"."party_contact_points"."city" is null and "party"."party_contact_points"."postal_code" is null and "party"."party_contact_points"."country_code" is null) or ("party"."party_contact_points"."contact_point_type" = 'PHONE' and length(btrim("party"."party_contact_points"."display_value")) > 0 and "party"."party_contact_points"."normalized_value" ~ '^\+[1-9][0-9]{6,14}$' and length(btrim("party"."party_contact_points"."normalization_version")) > 0 and ("party"."party_contact_points"."phone_country_code" is null or "party"."party_contact_points"."phone_country_code" ~ '^[A-Z]{2}$') and ("party"."party_contact_points"."phone_extension" is null or "party"."party_contact_points"."phone_extension" ~ '^[0-9]{1,12}$') and "party"."party_contact_points"."address_line_1" is null and "party"."party_contact_points"."city" is null and "party"."party_contact_points"."postal_code" is null and "party"."party_contact_points"."country_code" is null) or ("party"."party_contact_points"."contact_point_type" = 'ADDRESS' and "party"."party_contact_points"."normalized_value" is null and "party"."party_contact_points"."normalization_version" is null and "party"."party_contact_points"."phone_country_code" is null and "party"."party_contact_points"."phone_extension" is null and "party"."party_contact_points"."country_code" ~ '^[A-Z]{2}$' and num_nonnulls(nullif(btrim("party"."party_contact_points"."address_line_1"), ''), nullif(btrim("party"."party_contact_points"."address_line_2"), ''), nullif(btrim("party"."party_contact_points"."city"), ''), nullif(btrim("party"."party_contact_points"."postal_code"), ''), nullif(btrim("party"."party_contact_points"."region"), '')) >= 2 and not "party"."party_contact_points"."preferred")),
	CONSTRAINT "party_contact_points_privacy_ck" CHECK ("party"."party_contact_points"."privacy_classification" in ('PUBLIC', 'BUSINESS_SENSITIVE', 'PERSONAL')),
	CONSTRAINT "party_contact_points_additional_evidence_ck" CHECK (jsonb_typeof("party"."party_contact_points"."additional_evidence_refs") = 'array' and jsonb_array_length("party"."party_contact_points"."additional_evidence_refs") <= 32),
	CONSTRAINT "party_contact_points_interval_ck" CHECK ("party"."party_contact_points"."valid_to" is null or "party"."party_contact_points"."valid_to" >= "party"."party_contact_points"."valid_from"),
	CONSTRAINT "party_contact_points_state_ck" CHECK ("party"."party_contact_points"."state" in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and (("party"."party_contact_points"."state" = 'ACTIVE' and "party"."party_contact_points"."is_current") or ("party"."party_contact_points"."state" <> 'ACTIVE' and not "party"."party_contact_points"."is_current"))),
	CONSTRAINT "party_contact_points_end_evidence_ck" CHECK (("party"."party_contact_points"."valid_to" is null and "party"."party_contact_points"."end_reason" is null and "party"."party_contact_points"."end_provenance_source" is null and "party"."party_contact_points"."end_provenance_method" is null and "party"."party_contact_points"."end_evidence_refs" is null and "party"."party_contact_points"."ended_by_action_invocation_id" is null and "party"."party_contact_points"."ended_by_principal_id" is null and "party"."party_contact_points"."ended_recorded_at" is null) or ("party"."party_contact_points"."valid_to" is not null and "party"."party_contact_points"."end_reason" = btrim("party"."party_contact_points"."end_reason") and length("party"."party_contact_points"."end_reason") > 0 and "party"."party_contact_points"."end_provenance_source" = btrim("party"."party_contact_points"."end_provenance_source") and length("party"."party_contact_points"."end_provenance_source") > 0 and "party"."party_contact_points"."end_provenance_method" = btrim("party"."party_contact_points"."end_provenance_method") and length("party"."party_contact_points"."end_provenance_method") > 0 and jsonb_typeof("party"."party_contact_points"."end_evidence_refs") = 'array' and jsonb_array_length("party"."party_contact_points"."end_evidence_refs") <= 32 and "party"."party_contact_points"."ended_by_action_invocation_id" is not null and "party"."party_contact_points"."ended_by_principal_id" is not null and "party"."party_contact_points"."ended_recorded_at" is not null and "party"."party_contact_points"."ended_recorded_at" >= "party"."party_contact_points"."recorded_at")),
	CONSTRAINT "party_contact_points_verification_ck" CHECK ("party"."party_contact_points"."verification_state" in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and ("party"."party_contact_points"."verification_state" <> 'VERIFIED' or ("party"."party_contact_points"."verified_at" is not null and length(btrim("party"."party_contact_points"."verification_method")) > 0 and length(btrim("party"."party_contact_points"."verifier_reference")) > 0))),
	CONSTRAINT "party_contact_points_revision_ck" CHECK ("party"."party_contact_points"."revision" > 0),
	CONSTRAINT "party_contact_points_external_evidence_ck" CHECK ("party"."party_contact_points"."external_evidence" is null or coalesce((jsonb_typeof("party"."party_contact_points"."external_evidence") = 'object' and octet_length("party"."party_contact_points"."external_evidence"::text) <= 4096 and "party"."party_contact_points"."external_evidence" ?& array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] and "party"."party_contact_points"."external_evidence" - array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] = '{}'::jsonb and "party"."party_contact_points"."external_evidence"->>'provider' = 'ares' and "party"."party_contact_points"."external_evidence"->>'authorityPolicyKey' = 'party_registry.ares_enrichment' and "party"."party_contact_points"."external_evidence"->>'authorityPolicyVersion' = '1' and coalesce("party"."party_contact_points"."external_evidence"->>'queryIco', '') ~ '^[0-9]{8}$' and coalesce(length("party"."party_contact_points"."external_evidence"->>'evidenceRef'), 0) between 1 and 200 and "party"."party_contact_points"."external_evidence"->>'fact' in ('BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS', 'PARTY_CANDIDATE') and "party"."party_contact_points"."external_evidence"->>'outcome' in ('PREFILL_ONLY', 'APPLY_ENRICHMENT', 'NO_CHANGE', 'NEEDS_CONFIRMATION', 'CORRECTION_CANDIDATE', 'IDENTITY_AMBIGUITY') and coalesce("party"."party_contact_points"."external_evidence"->>'reasonCode', '') ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' and length("party"."party_contact_points"."external_evidence"->>'reasonCode') <= 100 and jsonb_typeof("party"."party_contact_points"."external_evidence"->'cacheAgeSeconds') = 'number' and coalesce("party"."party_contact_points"."external_evidence"->>'cacheAgeSeconds', '') ~ '^[0-9]+$' and coalesce("party"."party_contact_points"."external_evidence"->>'observedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_contact_points"."external_evidence"->>'servedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_contact_points"."external_evidence"->>'decidedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and ("party"."party_contact_points"."external_evidence"->'providerChangedOn' = 'null'::jsonb or coalesce("party"."party_contact_points"."external_evidence"->>'providerChangedOn', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and ("party"."party_contact_points"."external_evidence"->'providerRecordRef' = 'null'::jsonb or (jsonb_typeof("party"."party_contact_points"."external_evidence"->'providerRecordRef') = 'string' and length("party"."party_contact_points"."external_evidence"->>'providerRecordRef') between 1 and 200))), false))
);
--> statement-breakpoint
ALTER TABLE "party"."party_contact_points" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_corrections" (
	"correction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"party_fact_assertion_id" uuid,
	"official_identifier_id" uuid,
	"contact_point_id" uuid,
	"relationship_id" uuid,
	"replacement_party_fact_assertion_id" uuid,
	"replacement_official_identifier_id" uuid,
	"replacement_contact_point_id" uuid,
	"replacement_relationship_id" uuid,
	"reason" text NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"approving_principal_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_corrections_tenant_id_uk" UNIQUE("tenant_id","correction_id"),
	CONSTRAINT "party_corrections_action_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "party_corrections_target_ck" CHECK (num_nonnulls("party"."party_corrections"."party_fact_assertion_id", "party"."party_corrections"."official_identifier_id", "party"."party_corrections"."contact_point_id", "party"."party_corrections"."relationship_id") = 1),
	CONSTRAINT "party_corrections_replacement_ck" CHECK (num_nonnulls("party"."party_corrections"."replacement_party_fact_assertion_id", "party"."party_corrections"."replacement_official_identifier_id", "party"."party_corrections"."replacement_contact_point_id", "party"."party_corrections"."replacement_relationship_id") <= 1),
	CONSTRAINT "party_corrections_reason_ck" CHECK ("party"."party_corrections"."reason" = btrim("party"."party_corrections"."reason") and length("party"."party_corrections"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_fact_assertions" (
	"assertion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"fact_kind" text NOT NULL,
	"normalized_value" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"external_evidence" jsonb,
	"provenance_authoritative" boolean DEFAULT false NOT NULL,
	"evidence_reference" text,
	"verification_state" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verification_method" text,
	"verifier_reference" text,
	"verified_by_principal_id" uuid,
	"verified_at" timestamp with time zone,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"supersedes_assertion_id" uuid,
	"retracts_assertion_id" uuid,
	CONSTRAINT "party_fact_assertions_tenant_id_uk" UNIQUE("tenant_id","assertion_id"),
	CONSTRAINT "party_fact_assertions_kind_ck" CHECK ("party"."party_fact_assertions"."fact_kind" in ('PARTY_TYPE', 'DISPLAY_NAME')),
	CONSTRAINT "party_fact_assertions_value_ck" CHECK ("party"."party_fact_assertions"."normalized_value" = btrim("party"."party_fact_assertions"."normalized_value") and length("party"."party_fact_assertions"."normalized_value") > 0),
	CONSTRAINT "party_fact_assertions_interval_ck" CHECK ("party"."party_fact_assertions"."valid_to" is null or "party"."party_fact_assertions"."valid_to" >= "party"."party_fact_assertions"."valid_from"),
	CONSTRAINT "party_fact_assertions_state_ck" CHECK ("party"."party_fact_assertions"."state" in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and (("party"."party_fact_assertions"."state" = 'ACTIVE' and "party"."party_fact_assertions"."is_current") or ("party"."party_fact_assertions"."state" <> 'ACTIVE' and not "party"."party_fact_assertions"."is_current"))),
	CONSTRAINT "party_fact_assertions_verification_ck" CHECK ("party"."party_fact_assertions"."verification_state" in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and ("party"."party_fact_assertions"."verification_state" <> 'VERIFIED' or "party"."party_fact_assertions"."verified_at" is not null)),
	CONSTRAINT "party_fact_assertions_external_evidence_ck" CHECK ("party"."party_fact_assertions"."external_evidence" is null or coalesce((jsonb_typeof("party"."party_fact_assertions"."external_evidence") = 'object' and octet_length("party"."party_fact_assertions"."external_evidence"::text) <= 4096 and "party"."party_fact_assertions"."external_evidence" ?& array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] and "party"."party_fact_assertions"."external_evidence" - array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] = '{}'::jsonb and "party"."party_fact_assertions"."external_evidence"->>'provider' = 'ares' and "party"."party_fact_assertions"."external_evidence"->>'authorityPolicyKey' = 'party_registry.ares_enrichment' and "party"."party_fact_assertions"."external_evidence"->>'authorityPolicyVersion' = '1' and coalesce("party"."party_fact_assertions"."external_evidence"->>'queryIco', '') ~ '^[0-9]{8}$' and coalesce(length("party"."party_fact_assertions"."external_evidence"->>'evidenceRef'), 0) between 1 and 200 and "party"."party_fact_assertions"."external_evidence"->>'fact' in ('BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS', 'PARTY_CANDIDATE') and "party"."party_fact_assertions"."external_evidence"->>'outcome' in ('PREFILL_ONLY', 'APPLY_ENRICHMENT', 'NO_CHANGE', 'NEEDS_CONFIRMATION', 'CORRECTION_CANDIDATE', 'IDENTITY_AMBIGUITY') and coalesce("party"."party_fact_assertions"."external_evidence"->>'reasonCode', '') ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' and length("party"."party_fact_assertions"."external_evidence"->>'reasonCode') <= 100 and jsonb_typeof("party"."party_fact_assertions"."external_evidence"->'cacheAgeSeconds') = 'number' and coalesce("party"."party_fact_assertions"."external_evidence"->>'cacheAgeSeconds', '') ~ '^[0-9]+$' and coalesce("party"."party_fact_assertions"."external_evidence"->>'observedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_fact_assertions"."external_evidence"->>'servedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_fact_assertions"."external_evidence"->>'decidedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and ("party"."party_fact_assertions"."external_evidence"->'providerChangedOn' = 'null'::jsonb or coalesce("party"."party_fact_assertions"."external_evidence"->>'providerChangedOn', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and ("party"."party_fact_assertions"."external_evidence"->'providerRecordRef' = 'null'::jsonb or (jsonb_typeof("party"."party_fact_assertions"."external_evidence"->'providerRecordRef') = 'string' and length("party"."party_fact_assertions"."external_evidence"->>'providerRecordRef') between 1 and 200))), false))
);
--> statement-breakpoint
ALTER TABLE "party"."party_fact_assertions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_identifier_claims" (
	"identifier_claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"identifier_type_key" text NOT NULL,
	"namespace" text NOT NULL,
	"normalized_value" text NOT NULL,
	"party_id" uuid NOT NULL,
	"official_identifier_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_identifier_claims_tenant_id_uk" UNIQUE("tenant_id","identifier_claim_id"),
	CONSTRAINT "party_identifier_claims_exact_claim_uk" UNIQUE("tenant_id","identifier_type_key","namespace","normalized_value"),
	CONSTRAINT "party_identifier_claims_type_ck" CHECK ("party"."party_identifier_claims"."identifier_type_key" in ('ICO', 'CZ_DIC'))
);
--> statement-breakpoint
ALTER TABLE "party"."party_identifier_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_match_decisions" (
	"match_decision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"candidate_fingerprint" text NOT NULL,
	"match_rule_version" text NOT NULL,
	"outcome" text NOT NULL,
	"party_id" uuid,
	"candidate_case_id" uuid,
	"evidence_explanation" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_match_decisions_tenant_id_uk" UNIQUE("tenant_id","match_decision_id"),
	CONSTRAINT "party_match_decisions_action_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "party_match_decisions_fingerprint_ck" CHECK ("party"."party_match_decisions"."candidate_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "party_match_decisions_outcome_ck" CHECK ("party"."party_match_decisions"."outcome" in ('CREATED', 'MATCHED', 'NO_MATCH', 'AMBIGUOUS')),
	CONSTRAINT "party_match_decisions_result_ck" CHECK (("party"."party_match_decisions"."outcome" in ('CREATED', 'MATCHED') and "party"."party_match_decisions"."party_id" is not null and "party"."party_match_decisions"."candidate_case_id" is null) or ("party"."party_match_decisions"."outcome" = 'AMBIGUOUS' and "party"."party_match_decisions"."party_id" is null and "party"."party_match_decisions"."candidate_case_id" is not null) or ("party"."party_match_decisions"."outcome" = 'NO_MATCH' and "party"."party_match_decisions"."party_id" is null and "party"."party_match_decisions"."candidate_case_id" is null))
);
--> statement-breakpoint
ALTER TABLE "party"."party_match_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_merges" (
	"merge_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"survivor_party_id" uuid NOT NULL,
	"status" text NOT NULL,
	"policy_version" text NOT NULL,
	"readiness_evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_merges_tenant_id_uk" UNIQUE("tenant_id","merge_id"),
	CONSTRAINT "party_merges_status_ck" CHECK ("party"."party_merges"."status" in ('PREPARED', 'BLOCKED')),
	CONSTRAINT "party_merges_prepared_evidence_ck" CHECK (
        coalesce((jsonb_typeof("party"."party_merges"."readiness_evidence") = 'object'
        and octet_length("party"."party_merges"."readiness_evidence"::text) <= 65536
        and "party"."party_merges"."readiness_evidence"->'version' = '1'::jsonb
        and coalesce(length(btrim("party"."party_merges"."readiness_evidence"->>'confirmedDuplicateDecisionId')), 0) between 1 and 300
        and coalesce(length(btrim("party"."party_merges"."readiness_evidence"->>'decisionActorPrincipalId')), 0) between 1 and 300
        and coalesce(length(btrim("party"."party_merges"."readiness_evidence"->>'selectionPolicyVersion')), 0) between 1 and 300
        and coalesce("party"."party_merges"."readiness_evidence"->>'selectionReason', '') in ('AUTHORITATIVE_EVIDENCE', 'REFERENCE_STABILITY', 'LIFECYCLE', 'DATA_COMPLETENESS', 'CREATION_AGE', 'STABLE_RESOURCE_IDENTITY')
        and coalesce(jsonb_typeof("party"."party_merges"."readiness_evidence"->'absorbedPartyRefs'), '') = 'array'
        and jsonb_array_length("party"."party_merges"."readiness_evidence"->'absorbedPartyRefs') between 1 and 100
        and coalesce(jsonb_typeof("party"."party_merges"."readiness_evidence"->'selectionEvidenceChain'), '') = 'array'
        and jsonb_array_length("party"."party_merges"."readiness_evidence"->'selectionEvidenceChain') between 3 and 8
        and not jsonb_path_exists("party"."party_merges"."readiness_evidence"->'selectionEvidenceChain', '$[*] ? (!exists(@.candidateSnapshots) || @.candidateSnapshots.type() != "array" || @.candidateSnapshots.size() < 2)')
        and not jsonb_path_exists("party"."party_merges"."readiness_evidence"->'absorbedPartyRefs', '$[*] ? (!exists(@.tenantId) || !exists(@.resourceId) || @.tenantId != $tenant || @.resourceId == $survivor || @.moduleId != "party.registry" || @.resourceType != "party.registry.party")', jsonb_build_object('tenant', "party"."party_merges"."tenant_id"::text, 'survivor', "party"."party_merges"."survivor_party_id"::text))
        and "party"."party_merges"."readiness_evidence"->'selectionEvidenceChain'->0->>'criterion' = 'CONFIRMED_DUPLICATE_SET'
        and "party"."party_merges"."readiness_evidence"->'selectionEvidenceChain'->1->>'criterion' = 'IDENTITY_SAFETY'
        and "party"."party_merges"."readiness_evidence"->'selectionEvidenceChain'->-1->>'criterion' = "party"."party_merges"."readiness_evidence"->>'selectionReason'
        and "party"."party_merges"."readiness_evidence"->'selectionEvidenceChain'->-1->'winnerPartyRef'->>'resourceId' = "party"."party_merges"."survivor_party_id"::text
        and "party"."party_merges"."readiness_evidence"->'selectionEvidenceChain'->-1->'winnerPartyRef'->>'tenantId' = "party"."party_merges"."tenant_id"::text
        ), false)
      )
);
--> statement-breakpoint
ALTER TABLE "party"."party_merges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_official_identifiers" (
	"official_identifier_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"identifier_type_key" text NOT NULL,
	"namespace" text NOT NULL,
	"jurisdiction" text DEFAULT 'CZ' NOT NULL,
	"normalized_value" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"external_evidence" jsonb,
	"verification_state" text DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_by_principal_id" uuid,
	"verified_at" timestamp with time zone,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"supersedes_official_identifier_id" uuid,
	"retracts_official_identifier_id" uuid,
	CONSTRAINT "party_official_identifiers_tenant_id_uk" UNIQUE("tenant_id","official_identifier_id"),
	CONSTRAINT "party_official_identifiers_type_ck" CHECK ("party"."party_official_identifiers"."identifier_type_key" in ('ICO', 'CZ_DIC')),
	CONSTRAINT "party_official_identifiers_normalized_value_ck" CHECK (("party"."party_official_identifiers"."identifier_type_key" = 'ICO' and "party"."party_official_identifiers"."normalized_value" ~ '^[0-9]{8}$') or ("party"."party_official_identifiers"."identifier_type_key" = 'CZ_DIC' and "party"."party_official_identifiers"."normalized_value" ~ '^CZ[0-9]{8,10}$')),
	CONSTRAINT "party_official_identifiers_interval_ck" CHECK ("party"."party_official_identifiers"."valid_to" is null or "party"."party_official_identifiers"."valid_to" >= "party"."party_official_identifiers"."valid_from"),
	CONSTRAINT "party_official_identifiers_state_ck" CHECK ("party"."party_official_identifiers"."state" in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and (("party"."party_official_identifiers"."state" = 'ACTIVE' and "party"."party_official_identifiers"."is_current") or ("party"."party_official_identifiers"."state" <> 'ACTIVE' and not "party"."party_official_identifiers"."is_current"))),
	CONSTRAINT "party_official_identifiers_verification_ck" CHECK ("party"."party_official_identifiers"."verification_state" in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and ("party"."party_official_identifiers"."verification_state" <> 'VERIFIED' or "party"."party_official_identifiers"."verified_at" is not null)),
	CONSTRAINT "party_official_identifiers_external_evidence_ck" CHECK ("party"."party_official_identifiers"."external_evidence" is null or coalesce((jsonb_typeof("party"."party_official_identifiers"."external_evidence") = 'object' and octet_length("party"."party_official_identifiers"."external_evidence"::text) <= 4096 and "party"."party_official_identifiers"."external_evidence" ?& array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] and "party"."party_official_identifiers"."external_evidence" - array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] = '{}'::jsonb and "party"."party_official_identifiers"."external_evidence"->>'provider' = 'ares' and "party"."party_official_identifiers"."external_evidence"->>'authorityPolicyKey' = 'party_registry.ares_enrichment' and "party"."party_official_identifiers"."external_evidence"->>'authorityPolicyVersion' = '1' and coalesce("party"."party_official_identifiers"."external_evidence"->>'queryIco', '') ~ '^[0-9]{8}$' and coalesce(length("party"."party_official_identifiers"."external_evidence"->>'evidenceRef'), 0) between 1 and 200 and "party"."party_official_identifiers"."external_evidence"->>'fact' in ('BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS', 'PARTY_CANDIDATE') and "party"."party_official_identifiers"."external_evidence"->>'outcome' in ('PREFILL_ONLY', 'APPLY_ENRICHMENT', 'NO_CHANGE', 'NEEDS_CONFIRMATION', 'CORRECTION_CANDIDATE', 'IDENTITY_AMBIGUITY') and coalesce("party"."party_official_identifiers"."external_evidence"->>'reasonCode', '') ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' and length("party"."party_official_identifiers"."external_evidence"->>'reasonCode') <= 100 and jsonb_typeof("party"."party_official_identifiers"."external_evidence"->'cacheAgeSeconds') = 'number' and coalesce("party"."party_official_identifiers"."external_evidence"->>'cacheAgeSeconds', '') ~ '^[0-9]+$' and coalesce("party"."party_official_identifiers"."external_evidence"->>'observedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_official_identifiers"."external_evidence"->>'servedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and coalesce("party"."party_official_identifiers"."external_evidence"->>'decidedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$' and ("party"."party_official_identifiers"."external_evidence"->'providerChangedOn' = 'null'::jsonb or coalesce("party"."party_official_identifiers"."external_evidence"->>'providerChangedOn', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and ("party"."party_official_identifiers"."external_evidence"->'providerRecordRef' = 'null'::jsonb or (jsonb_typeof("party"."party_official_identifiers"."external_evidence"->'providerRecordRef') = 'string' and length("party"."party_official_identifiers"."external_evidence"->>'providerRecordRef') between 1 and 200))), false))
);
--> statement-breakpoint
ALTER TABLE "party"."party_official_identifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party"."party_relationships" (
	"relationship_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_party_id" uuid NOT NULL,
	"to_party_id" uuid NOT NULL,
	"relationship_type" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assertion_state" text DEFAULT 'ACTIVE' NOT NULL,
	"provenance_source" text NOT NULL,
	"provenance_method" text NOT NULL,
	"accepted_by_action_invocation_id" uuid NOT NULL,
	"accepted_by_principal_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"end_reason" text,
	"end_provenance_source" text,
	"end_provenance_method" text,
	"end_evidence_reference" text,
	"ended_by_action_invocation_id" uuid,
	"ended_by_principal_id" uuid,
	"ended_recorded_at" timestamp with time zone,
	"supersedes_relationship_id" uuid,
	"retracts_relationship_id" uuid,
	CONSTRAINT "party_relationships_tenant_id_uk" UNIQUE("tenant_id","relationship_id"),
	CONSTRAINT "party_relationships_type_ck" CHECK ("party"."party_relationships"."relationship_type" = 'CONTACT_PERSON_OF'),
	CONSTRAINT "party_relationships_endpoints_ck" CHECK ("party"."party_relationships"."from_party_id" <> "party"."party_relationships"."to_party_id"),
	CONSTRAINT "party_relationships_interval_ck" CHECK ("party"."party_relationships"."valid_to" is null or "party"."party_relationships"."valid_from" is null or "party"."party_relationships"."valid_to" > "party"."party_relationships"."valid_from"),
	CONSTRAINT "party_relationships_assertion_state_ck" CHECK ("party"."party_relationships"."assertion_state" in ('ACTIVE', 'SUPERSEDED', 'RETRACTED', 'DISPUTED')),
	CONSTRAINT "party_relationships_revision_ck" CHECK ("party"."party_relationships"."revision" > 0),
	CONSTRAINT "party_relationships_end_reason_ck" CHECK ("party"."party_relationships"."end_reason" is null or ("party"."party_relationships"."end_reason" = btrim("party"."party_relationships"."end_reason") and length("party"."party_relationships"."end_reason") > 0)),
	CONSTRAINT "party_relationships_end_provenance_ck" CHECK (("party"."party_relationships"."end_provenance_source" is null and "party"."party_relationships"."end_provenance_method" is null and "party"."party_relationships"."end_evidence_reference" is null and "party"."party_relationships"."ended_by_action_invocation_id" is null and "party"."party_relationships"."ended_by_principal_id" is null and "party"."party_relationships"."ended_recorded_at" is null and "party"."party_relationships"."end_reason" is null) or ("party"."party_relationships"."valid_to" is not null and length(btrim("party"."party_relationships"."end_provenance_source")) > 0 and length(btrim("party"."party_relationships"."end_provenance_method")) > 0 and "party"."party_relationships"."ended_by_action_invocation_id" is not null and "party"."party_relationships"."ended_by_principal_id" is not null and "party"."party_relationships"."ended_recorded_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "party"."party_relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "party"."counterparties" ADD CONSTRAINT "party_counterparties_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."counterparty_admin_read_models" ADD CONSTRAINT "party_counterparty_admin_model_source_fk" FOREIGN KEY ("tenant_id","counterparty_id","legal_entity_id","stored_party_id") REFERENCES "party"."counterparties"("tenant_id","counterparty_id","legal_entity_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."counterparty_admin_read_models" ADD CONSTRAINT "party_counterparty_admin_model_party_fk" FOREIGN KEY ("tenant_id","stored_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_admin_read_models" ADD CONSTRAINT "party_counterparty_role_admin_model_source_fk" FOREIGN KEY ("tenant_id","counterparty_id","role_period_id") REFERENCES "party"."counterparty_role_periods"("tenant_id","counterparty_id","role_period_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_admin_read_models" ADD CONSTRAINT "party_counterparty_role_admin_model_counterparty_fk" FOREIGN KEY ("tenant_id","counterparty_id") REFERENCES "party"."counterparty_admin_read_models"("tenant_id","counterparty_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_periods" ADD CONSTRAINT "party_role_periods_scope_counterparty_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_id") REFERENCES "party"."counterparties"("tenant_id","legal_entity_id","counterparty_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_case_parties" ADD CONSTRAINT "party_case_parties_tenant_case_fk" FOREIGN KEY ("tenant_id","candidate_case_id") REFERENCES "party"."duplicate_candidate_cases"("tenant_id","candidate_case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_case_parties" ADD CONSTRAINT "party_duplicate_candidate_case_parties_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_cases" ADD CONSTRAINT "party_duplicate_cases_prior_case_fk" FOREIGN KEY ("tenant_id","prior_candidate_case_id") REFERENCES "party"."duplicate_candidate_cases"("tenant_id","candidate_case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_cases" ADD CONSTRAINT "party_duplicate_cases_selected_party_fk" FOREIGN KEY ("tenant_id","selected_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_aliases" ADD CONSTRAINT "party_aliases_tenant_alias_fk" FOREIGN KEY ("tenant_id","alias_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_aliases" ADD CONSTRAINT "party_aliases_tenant_canonical_fk" FOREIGN KEY ("tenant_id","canonical_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_aliases" ADD CONSTRAINT "party_aliases_tenant_merge_fk" FOREIGN KEY ("tenant_id","merge_id") REFERENCES "party"."party_merges"("tenant_id","merge_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_contact_point_purposes" ADD CONSTRAINT "party_contact_point_purposes_contact_fk" FOREIGN KEY ("tenant_id","party_id","contact_point_id") REFERENCES "party"."party_contact_points"("tenant_id","party_id","contact_point_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_contact_points" ADD CONSTRAINT "party_contact_points_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_contact_points" ADD CONSTRAINT "party_contact_points_tenant_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_contact_point_id") REFERENCES "party"."party_contact_points"("tenant_id","contact_point_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_contact_points" ADD CONSTRAINT "party_contact_points_tenant_retracts_fk" FOREIGN KEY ("tenant_id","retracts_contact_point_id") REFERENCES "party"."party_contact_points"("tenant_id","contact_point_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_fact_fk" FOREIGN KEY ("tenant_id","party_fact_assertion_id") REFERENCES "party"."party_fact_assertions"("tenant_id","assertion_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_identifier_fk" FOREIGN KEY ("tenant_id","official_identifier_id") REFERENCES "party"."party_official_identifiers"("tenant_id","official_identifier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_contact_fk" FOREIGN KEY ("tenant_id","contact_point_id") REFERENCES "party"."party_contact_points"("tenant_id","contact_point_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_relationship_fk" FOREIGN KEY ("tenant_id","relationship_id") REFERENCES "party"."party_relationships"("tenant_id","relationship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_replacement_fact_fk" FOREIGN KEY ("tenant_id","replacement_party_fact_assertion_id") REFERENCES "party"."party_fact_assertions"("tenant_id","assertion_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_replacement_id_fk" FOREIGN KEY ("tenant_id","replacement_official_identifier_id") REFERENCES "party"."party_official_identifiers"("tenant_id","official_identifier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_replacement_contact_fk" FOREIGN KEY ("tenant_id","replacement_contact_point_id") REFERENCES "party"."party_contact_points"("tenant_id","contact_point_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_corrections" ADD CONSTRAINT "party_corrections_tenant_replacement_rel_fk" FOREIGN KEY ("tenant_id","replacement_relationship_id") REFERENCES "party"."party_relationships"("tenant_id","relationship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_fact_assertions" ADD CONSTRAINT "party_fact_assertions_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_fact_assertions" ADD CONSTRAINT "party_fact_assertions_tenant_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_assertion_id") REFERENCES "party"."party_fact_assertions"("tenant_id","assertion_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_fact_assertions" ADD CONSTRAINT "party_fact_assertions_tenant_retracts_fk" FOREIGN KEY ("tenant_id","retracts_assertion_id") REFERENCES "party"."party_fact_assertions"("tenant_id","assertion_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_identifier_claims" ADD CONSTRAINT "party_identifier_claims_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_identifier_claims" ADD CONSTRAINT "party_identifier_claims_tenant_identifier_fk" FOREIGN KEY ("tenant_id","official_identifier_id") REFERENCES "party"."party_official_identifiers"("tenant_id","official_identifier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_match_decisions" ADD CONSTRAINT "party_match_decisions_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_match_decisions" ADD CONSTRAINT "party_match_decisions_tenant_case_fk" FOREIGN KEY ("tenant_id","candidate_case_id") REFERENCES "party"."duplicate_candidate_cases"("tenant_id","candidate_case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_merges" ADD CONSTRAINT "party_merges_tenant_survivor_fk" FOREIGN KEY ("tenant_id","survivor_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_official_identifiers" ADD CONSTRAINT "party_official_identifiers_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_official_identifiers" ADD CONSTRAINT "party_official_identifiers_tenant_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_official_identifier_id") REFERENCES "party"."party_official_identifiers"("tenant_id","official_identifier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_official_identifiers" ADD CONSTRAINT "party_official_identifiers_tenant_retracts_fk" FOREIGN KEY ("tenant_id","retracts_official_identifier_id") REFERENCES "party"."party_official_identifiers"("tenant_id","official_identifier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_relationships" ADD CONSTRAINT "party_relationships_tenant_from_party_fk" FOREIGN KEY ("tenant_id","from_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_relationships" ADD CONSTRAINT "party_relationships_tenant_to_party_fk" FOREIGN KEY ("tenant_id","to_party_id") REFERENCES "party"."parties"("tenant_id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_relationships" ADD CONSTRAINT "party_relationships_tenant_supersedes_fk" FOREIGN KEY ("tenant_id","supersedes_relationship_id") REFERENCES "party"."party_relationships"("tenant_id","relationship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party"."party_relationships" ADD CONSTRAINT "party_relationships_tenant_retracts_fk" FOREIGN KEY ("tenant_id","retracts_relationship_id") REFERENCES "party"."party_relationships"("tenant_id","relationship_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_counterparties_current_idx" ON "party"."counterparties" USING btree ("tenant_id","legal_entity_id","party_id") WHERE "party"."counterparties"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "party_counterparty_role_admin_models_history_idx" ON "party"."counterparty_role_admin_read_models" USING btree ("tenant_id","counterparty_id","valid_from","role_type");--> statement-breakpoint
CREATE UNIQUE INDEX "party_duplicate_cases_fingerprint_uk" ON "party"."duplicate_candidate_cases" USING btree ("tenant_id","evaluation_fingerprint","match_rule_version") WHERE "party"."duplicate_candidate_cases"."lifecycle_state" in ('OPEN', 'NEEDS_EVIDENCE');--> statement-breakpoint
CREATE INDEX "party_duplicate_cases_input_history_idx" ON "party"."duplicate_candidate_cases" USING btree ("tenant_id","candidate_fingerprint","created_at");--> statement-breakpoint
CREATE INDEX "party_parties_current_name_idx" ON "party"."parties" USING btree ("tenant_id","current_display_name") WHERE "party"."parties"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "party_contact_point_purposes_current_idx" ON "party"."party_contact_point_purposes" USING btree ("tenant_id","party_id","purpose_key") WHERE "party"."party_contact_point_purposes"."state" = 'ACTIVE' and "party"."party_contact_point_purposes"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "party_contact_point_purposes_current_preferred_uk" ON "party"."party_contact_point_purposes" USING btree ("tenant_id","party_id","purpose_key","registry_context","jurisdiction") WHERE "party"."party_contact_point_purposes"."preferred" and "party"."party_contact_point_purposes"."state" = 'ACTIVE' and "party"."party_contact_point_purposes"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "party_contact_point_purposes_current_registered_uk" ON "party"."party_contact_point_purposes" USING btree ("tenant_id","party_id","registry_context","jurisdiction") WHERE "party"."party_contact_point_purposes"."purpose_key" = 'REGISTERED' and "party"."party_contact_point_purposes"."state" = 'ACTIVE' and "party"."party_contact_point_purposes"."is_current";--> statement-breakpoint
CREATE INDEX "party_contact_points_current_idx" ON "party"."party_contact_points" USING btree ("tenant_id","party_id","contact_point_type") WHERE "party"."party_contact_points"."state" = 'ACTIVE' and "party"."party_contact_points"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "party_contact_points_current_preferred_uk" ON "party"."party_contact_points" USING btree ("tenant_id","party_id","contact_point_type") WHERE "party"."party_contact_points"."preferred" and "party"."party_contact_points"."contact_point_type" in ('EMAIL', 'PHONE') and "party"."party_contact_points"."state" = 'ACTIVE' and "party"."party_contact_points"."is_current";--> statement-breakpoint
CREATE INDEX "party_fact_assertions_current_idx" ON "party"."party_fact_assertions" USING btree ("tenant_id","party_id","fact_kind") WHERE "party"."party_fact_assertions"."state" = 'ACTIVE' and "party"."party_fact_assertions"."is_current";--> statement-breakpoint
CREATE INDEX "party_identifier_claims_party_lookup_idx" ON "party"."party_identifier_claims" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE INDEX "party_official_identifiers_party_idx" ON "party"."party_official_identifiers" USING btree ("tenant_id","party_id","identifier_type_key");--> statement-breakpoint
CREATE INDEX "party_relationships_interval_idx" ON "party"."party_relationships" USING btree ("tenant_id","from_party_id","to_party_id","relationship_type","valid_from","valid_to");--> statement-breakpoint
CREATE POLICY "party_counterparties_scope_select" ON "party"."counterparties" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."counterparties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparties"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_counterparties_scope_insert" ON "party"."counterparties" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."counterparties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparties"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_counterparties_scope_update" ON "party"."counterparties" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."counterparties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparties"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("party"."counterparties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparties"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_counterparties_scope_delete" ON "party"."counterparties" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."counterparties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparties"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_admin_read_models_tenant_select" ON "party"."counterparty_admin_read_models" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."counterparty_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_admin_read_models_tenant_insert" ON "party"."counterparty_admin_read_models" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."counterparty_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_admin_read_models_tenant_update" ON "party"."counterparty_admin_read_models" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."counterparty_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."counterparty_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_admin_read_models_tenant_delete" ON "party"."counterparty_admin_read_models" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."counterparty_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_role_admin_read_models_tenant_select" ON "party"."counterparty_role_admin_read_models" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."counterparty_role_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_role_admin_read_models_tenant_insert" ON "party"."counterparty_role_admin_read_models" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."counterparty_role_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_role_admin_read_models_tenant_update" ON "party"."counterparty_role_admin_read_models" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."counterparty_role_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."counterparty_role_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "counterparty_role_admin_read_models_tenant_delete" ON "party"."counterparty_role_admin_read_models" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."counterparty_role_admin_read_models"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_role_periods_scope_select" ON "party"."counterparty_role_periods" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."counterparty_role_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparty_role_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_role_periods_scope_insert" ON "party"."counterparty_role_periods" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."counterparty_role_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparty_role_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_role_periods_scope_update" ON "party"."counterparty_role_periods" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."counterparty_role_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparty_role_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("party"."counterparty_role_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparty_role_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_role_periods_scope_delete" ON "party"."counterparty_role_periods" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."counterparty_role_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "party"."counterparty_role_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_case_parties_tenant_select" ON "party"."duplicate_candidate_case_parties" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."duplicate_candidate_case_parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_case_parties_tenant_insert" ON "party"."duplicate_candidate_case_parties" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."duplicate_candidate_case_parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_case_parties_tenant_update" ON "party"."duplicate_candidate_case_parties" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."duplicate_candidate_case_parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."duplicate_candidate_case_parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_case_parties_tenant_delete" ON "party"."duplicate_candidate_case_parties" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."duplicate_candidate_case_parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_duplicate_cases_tenant_select" ON "party"."duplicate_candidate_cases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."duplicate_candidate_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_duplicate_cases_tenant_insert" ON "party"."duplicate_candidate_cases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."duplicate_candidate_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_duplicate_cases_tenant_update" ON "party"."duplicate_candidate_cases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."duplicate_candidate_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."duplicate_candidate_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_duplicate_cases_tenant_delete" ON "party"."duplicate_candidate_cases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."duplicate_candidate_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_parties_tenant_select" ON "party"."parties" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_parties_tenant_insert" ON "party"."parties" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_parties_tenant_update" ON "party"."parties" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_parties_tenant_delete" ON "party"."parties" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."parties"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_aliases_tenant_select" ON "party"."party_aliases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_aliases_tenant_insert" ON "party"."party_aliases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_aliases_tenant_update" ON "party"."party_aliases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_aliases_tenant_delete" ON "party"."party_aliases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_aliases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_point_purposes_tenant_select" ON "party"."party_contact_point_purposes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_contact_point_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_point_purposes_tenant_insert" ON "party"."party_contact_point_purposes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_contact_point_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_point_purposes_tenant_update" ON "party"."party_contact_point_purposes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_contact_point_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_contact_point_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_point_purposes_tenant_delete" ON "party"."party_contact_point_purposes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_contact_point_purposes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_points_tenant_select" ON "party"."party_contact_points" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_contact_points"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_points_tenant_insert" ON "party"."party_contact_points" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_contact_points"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_points_tenant_update" ON "party"."party_contact_points" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_contact_points"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_contact_points"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_contact_points_tenant_delete" ON "party"."party_contact_points" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_contact_points"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_corrections_tenant_select" ON "party"."party_corrections" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_corrections_tenant_insert" ON "party"."party_corrections" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_corrections_tenant_update" ON "party"."party_corrections" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_corrections_tenant_delete" ON "party"."party_corrections" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_corrections"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_fact_assertions_tenant_select" ON "party"."party_fact_assertions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_fact_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_fact_assertions_tenant_insert" ON "party"."party_fact_assertions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_fact_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_fact_assertions_tenant_update" ON "party"."party_fact_assertions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_fact_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_fact_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_fact_assertions_tenant_delete" ON "party"."party_fact_assertions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_fact_assertions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_identifier_claims_tenant_select" ON "party"."party_identifier_claims" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_identifier_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_identifier_claims_tenant_insert" ON "party"."party_identifier_claims" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_identifier_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_identifier_claims_tenant_update" ON "party"."party_identifier_claims" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_identifier_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_identifier_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_identifier_claims_tenant_delete" ON "party"."party_identifier_claims" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_identifier_claims"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_match_decisions_tenant_select" ON "party"."party_match_decisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_match_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_match_decisions_tenant_insert" ON "party"."party_match_decisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_match_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_match_decisions_tenant_update" ON "party"."party_match_decisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_match_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_match_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_match_decisions_tenant_delete" ON "party"."party_match_decisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_match_decisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_merges_tenant_select" ON "party"."party_merges" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_merges"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_merges_tenant_insert" ON "party"."party_merges" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_merges"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_merges_tenant_update" ON "party"."party_merges" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_merges"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_merges"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_merges_tenant_delete" ON "party"."party_merges" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_merges"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_official_identifiers_tenant_select" ON "party"."party_official_identifiers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_official_identifiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_official_identifiers_tenant_insert" ON "party"."party_official_identifiers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_official_identifiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_official_identifiers_tenant_update" ON "party"."party_official_identifiers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_official_identifiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_official_identifiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_official_identifiers_tenant_delete" ON "party"."party_official_identifiers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_official_identifiers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_relationships_tenant_select" ON "party"."party_relationships" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("party"."party_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_relationships_tenant_insert" ON "party"."party_relationships" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("party"."party_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_relationships_tenant_update" ON "party"."party_relationships" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("party"."party_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("party"."party_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_relationships_tenant_delete" ON "party"."party_relationships" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("party"."party_relationships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "party"."counterparties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."counterparty_admin_read_models" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_admin_read_models" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."counterparty_role_periods" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_case_parties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."duplicate_candidate_cases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."parties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_aliases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_contact_point_purposes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_contact_points" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_corrections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_fact_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_identifier_claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_match_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_merges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_official_identifiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "party"."party_relationships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Counterparty role periods serialize on half-open effective intervals; adjacent periods are valid.
ALTER TABLE "party"."counterparty_role_periods"
ADD CONSTRAINT "party_counterparty_role_periods_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "counterparty_id" WITH =,
  "role_type" WITH =,
  tstzrange("valid_from", coalesce("valid_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("state" in ('ACTIVE', 'ENDED'));
--> statement-breakpoint
-- Canonical relationship assertions serialize on effective intervals; an unknown start is conservatively unbounded.
ALTER TABLE "party"."party_relationships"
ADD CONSTRAINT "party_relationships_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "from_party_id" WITH =,
  "to_party_id" WITH =,
  "relationship_type" WITH =,
  tstzrange(coalesce("valid_from", '-infinity'::timestamptz), coalesce("valid_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("assertion_state" = 'ACTIVE');
--> statement-breakpoint
-- Correction provenance is evidence: application code can append it but cannot rewrite or erase it.
create function "party"."party_reject_correction_mutation"()
returns trigger
language plpgsql
as $$
begin
  raise exception 'party corrections are append-only' using errcode = '55000';
end;
$$;
--> statement-breakpoint
create trigger "party_corrections_append_only"
before update or delete on "party"."party_corrections"
for each row execute function "party"."party_reject_correction_mutation"();
