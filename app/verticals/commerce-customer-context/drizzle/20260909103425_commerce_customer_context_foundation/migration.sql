CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE SCHEMA "commerce_customer_context";
--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."access_mutation_journal" (
	"access_mutation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_purchasing_profile_id" uuid NOT NULL,
	"subject_principal_id" uuid,
	"mutation_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"safe_facts" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_access_journal_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","access_mutation_id"),
	CONSTRAINT "ccc_access_journal_action_uk" UNIQUE("tenant_id","action_invocation_id","mutation_kind","resource_id"),
	CONSTRAINT "ccc_access_journal_kind_ck" CHECK ("mutation_kind" in ('BOOTSTRAP_ADMIN', 'GRANT', 'REVOKE', 'INVITE', 'RESEND_INVITE', 'CLAIM_INVITE', 'REVOKE_INVITE')),
	CONSTRAINT "ccc_access_journal_facts_ck" CHECK (jsonb_typeof("safe_facts") = 'object' and octet_length("safe_facts"::text) <= 8192),
	CONSTRAINT "ccc_access_journal_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_access_journal_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."access_mutation_journal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."counterparty_access_invitations" (
	"counterparty_access_invitation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_purchasing_profile_id" uuid NOT NULL,
	"invitee_email_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"requested_permission_codes" jsonb NOT NULL,
	"storefront_resource_id" text,
	"lifecycle" text DEFAULT 'PENDING' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_principal_id" uuid,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_access_invitations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_access_invitation_id"),
	CONSTRAINT "ccc_access_invitations_token_hash_uk" UNIQUE("tenant_id","token_hash"),
	CONSTRAINT "ccc_access_invitations_email_hash_ck" CHECK ("invitee_email_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccc_access_invitations_token_hash_ck" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccc_access_invitations_permissions_ck" CHECK (jsonb_typeof("requested_permission_codes") = 'array' and jsonb_array_length("requested_permission_codes") between 1 and 64),
	CONSTRAINT "ccc_access_invitations_lifecycle_ck" CHECK ("lifecycle" in ('PENDING', 'CLAIMED', 'REVOKED', 'EXPIRED')),
	CONSTRAINT "ccc_access_invitations_claim_ck" CHECK (("lifecycle" = 'CLAIMED' and "claimed_by_principal_id" is not null and "claimed_at" is not null and "revoked_at" is null) or ("lifecycle" <> 'CLAIMED' and "claimed_by_principal_id" is null and "claimed_at" is null)),
	CONSTRAINT "ccc_access_invitations_revocation_ck" CHECK (("lifecycle" = 'REVOKED' and "revoked_at" is not null) or ("lifecycle" <> 'REVOKED' and "revoked_at" is null)),
	CONSTRAINT "ccc_access_invitations_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_access_invitations_storefront_ck" CHECK ("storefront_resource_id" is null or ("storefront_resource_id" = btrim("storefront_resource_id") and length("storefront_resource_id") > 0)),
	CONSTRAINT "ccc_access_invitations_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."counterparty_commerce_access_grants" (
	"counterparty_commerce_access_grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_purchasing_profile_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	"storefront_resource_id" text,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_access_grants_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_commerce_access_grant_id"),
	CONSTRAINT "ccc_access_grants_permission_ck" CHECK ("permission_code" = btrim("permission_code") and length("permission_code") > 0),
	CONSTRAINT "ccc_access_grants_storefront_ck" CHECK ("storefront_resource_id" is null or ("storefront_resource_id" = btrim("storefront_resource_id") and length("storefront_resource_id") > 0)),
	CONSTRAINT "ccc_access_grants_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'REVOKED') and (("lifecycle" = 'ACTIVE' and "revoked_at" is null) or ("lifecycle" = 'REVOKED' and "revoked_at" is not null))),
	CONSTRAINT "ccc_access_grants_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_access_grants_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_commerce_access_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."counterparty_purchase_limit_defaults" (
	"counterparty_purchase_limit_default_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_purchasing_profile_id" uuid NOT NULL,
	"policy_kind" text NOT NULL,
	"amount" numeric(38,18),
	"currency_code" text,
	"revision" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_limit_defaults_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_purchase_limit_default_id"),
	CONSTRAINT "ccc_limit_defaults_profile_revision_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","revision"),
	CONSTRAINT "ccc_limit_defaults_value_ck" CHECK (("policy_kind" = 'UNLIMITED' and "amount" is null and "currency_code" is null) or ("policy_kind" = 'MONETARY_LIMIT' and "amount" is not null and "amount" >= 0 and "currency_code" ~ '^[A-Z]{3}$')),
	CONSTRAINT "ccc_limit_defaults_current_ck" CHECK (("is_current" and "superseded_at" is null) or (not "is_current" and "superseded_at" is not null)),
	CONSTRAINT "ccc_limit_defaults_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_limit_defaults_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchase_limit_defaults" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."counterparty_purchasing_profiles" (
	"counterparty_purchasing_profile_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_resource_id" text NOT NULL,
	"counterparty_resource_revision" text,
	"customer_role_resource_id" text,
	"customer_role_resource_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_counterparty_profiles_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_purchasing_profile_id"),
	CONSTRAINT "ccc_counterparty_profiles_business_key_uk" UNIQUE("tenant_id","counterparty_resource_id"),
	CONSTRAINT "ccc_counterparty_profiles_counterparty_ref_ck" CHECK ("counterparty_resource_id" = btrim("counterparty_resource_id") and length("counterparty_resource_id") > 0),
	CONSTRAINT "ccc_counterparty_profiles_counterparty_revision_ck" CHECK ("counterparty_resource_revision" is null or ("counterparty_resource_revision" = btrim("counterparty_resource_revision") and length("counterparty_resource_revision") > 0)),
	CONSTRAINT "ccc_counterparty_profiles_role_ref_ck" CHECK ("customer_role_resource_id" is null or ("customer_role_resource_id" = btrim("customer_role_resource_id") and length("customer_role_resource_id") > 0)),
	CONSTRAINT "ccc_counterparty_profiles_role_revision_ck" CHECK ("customer_role_resource_revision" is null or ("customer_role_resource_revision" = btrim("customer_role_resource_revision") and length("customer_role_resource_revision") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_address_defaults" (
	"customer_address_default_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"default_kind" text NOT NULL,
	"saved_address_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"revision" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_address_defaults_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_address_default_id"),
	CONSTRAINT "ccc_address_defaults_profile_revision_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","default_kind","revision"),
	CONSTRAINT "ccc_address_defaults_kind_ck" CHECK ("default_kind" in ('BILLING', 'DELIVERY')),
	CONSTRAINT "ccc_address_defaults_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_address_defaults_current_ck" CHECK (("is_current" and "effective_to" is null) or not "is_current"),
	CONSTRAINT "ccc_address_defaults_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED')),
	CONSTRAINT "ccc_address_defaults_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_address_defaults_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_currency_preferences" (
	"customer_currency_preference_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"revision" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_currency_preferences_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_currency_preference_id"),
	CONSTRAINT "ccc_currency_preferences_profile_revision_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","revision"),
	CONSTRAINT "ccc_currency_preferences_code_ck" CHECK ("currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ccc_currency_preferences_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_currency_preferences_current_ck" CHECK (("is_current" and "effective_to" is null) or not "is_current"),
	CONSTRAINT "ccc_currency_preferences_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED')),
	CONSTRAINT "ccc_currency_preferences_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_currency_preferences_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_group_memberships" (
	"customer_group_membership_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"customer_group_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_memberships_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_membership_id"),
	CONSTRAINT "ccc_memberships_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_memberships_current_ck" CHECK (("is_current" and "effective_to" is null) or not "is_current"),
	CONSTRAINT "ccc_memberships_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED')),
	CONSTRAINT "ccc_memberships_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_memberships_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_group_revisions" (
	"customer_group_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_group_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"semantic_fingerprint" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_group_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_revision_id"),
	CONSTRAINT "ccc_group_revisions_group_revision_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_id","revision"),
	CONSTRAINT "ccc_group_revisions_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_group_revisions_name_ck" CHECK ("display_name" = btrim("display_name") and length("display_name") > 0),
	CONSTRAINT "ccc_group_revisions_description_ck" CHECK ("description" is null or ("description" = btrim("description") and length("description") > 0)),
	CONSTRAINT "ccc_group_revisions_fingerprint_ck" CHECK ("semantic_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccc_group_revisions_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_groups" (
	"customer_group_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"stable_code" text NOT NULL,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "ccc_groups_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_id"),
	CONSTRAINT "ccc_groups_code_uk" UNIQUE("tenant_id","legal_entity_id","stable_code"),
	CONSTRAINT "ccc_groups_code_ck" CHECK ("stable_code" = btrim("stable_code") and length("stable_code") > 0),
	CONSTRAINT "ccc_groups_code_format_ck" CHECK ("stable_code" ~ '^[a-z][a-z0-9._-]{0,99}$'),
	CONSTRAINT "ccc_groups_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ARCHIVED') and (("lifecycle" = 'ACTIVE' and "archived_at" is null) or ("lifecycle" = 'ARCHIVED' and "archived_at" is not null))),
	CONSTRAINT "ccc_groups_revision_ck" CHECK ("current_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_payment_term_entitlements" (
	"customer_payment_term_entitlement_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"payment_term_resource_id" text NOT NULL,
	"payment_term_semantic_revision" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"revision" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_payment_entitlements_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_payment_term_entitlement_id"),
	CONSTRAINT "ccc_payment_entitlements_profile_revision_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","revision"),
	CONSTRAINT "ccc_payment_entitlements_term_ref_ck" CHECK ("payment_term_resource_id" = btrim("payment_term_resource_id") and length("payment_term_resource_id") > 0),
	CONSTRAINT "ccc_payment_entitlements_semantic_revision_ck" CHECK ("payment_term_semantic_revision" = btrim("payment_term_semantic_revision") and length("payment_term_semantic_revision") > 0),
	CONSTRAINT "ccc_payment_entitlements_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_payment_entitlements_current_ck" CHECK (("is_current" and "effective_to" is null) or not "is_current"),
	CONSTRAINT "ccc_payment_entitlements_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED')),
	CONSTRAINT "ccc_payment_entitlements_preferred_ck" CHECK (not "is_preferred" or ("lifecycle" = 'ACTIVE' and "is_current")),
	CONSTRAINT "ccc_payment_entitlements_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_payment_entitlements_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_price_group_assignments" (
	"customer_price_group_assignment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"price_group_resource_id" text NOT NULL,
	"price_group_revision" text NOT NULL,
	"contract_compatibility_key" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_price_assignments_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_price_group_assignment_id"),
	CONSTRAINT "ccc_price_assignments_group_ref_ck" CHECK ("price_group_resource_id" = btrim("price_group_resource_id") and length("price_group_resource_id") > 0),
	CONSTRAINT "ccc_price_assignments_revision_ref_ck" CHECK ("price_group_revision" = btrim("price_group_revision") and length("price_group_revision") > 0),
	CONSTRAINT "ccc_price_assignments_compatibility_ck" CHECK ("contract_compatibility_key" = btrim("contract_compatibility_key") and length("contract_compatibility_key") > 0),
	CONSTRAINT "ccc_price_assignments_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_price_assignments_current_ck" CHECK (("is_current" and "effective_to" is null) or not "is_current"),
	CONSTRAINT "ccc_price_assignments_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED')),
	CONSTRAINT "ccc_price_assignments_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_price_assignments_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_profile_lifecycle_history" (
	"lifecycle_history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"from_lifecycle" text,
	"to_lifecycle" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_profile_history_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","lifecycle_history_id"),
	CONSTRAINT "ccc_profile_history_revision_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","revision"),
	CONSTRAINT "ccc_profile_history_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_profile_history_from_state_ck" CHECK ("from_lifecycle" is null or "from_lifecycle" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
	CONSTRAINT "ccc_profile_history_to_state_ck" CHECK ("to_lifecycle" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
	CONSTRAINT "ccc_profile_history_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_lifecycle_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_profiles" (
	"customer_profile_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"profile_kind" text NOT NULL,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_profiles_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id"),
	CONSTRAINT "ccc_profiles_kind_ck" CHECK ("profile_kind" in ('RETAIL', 'COUNTERPARTY')),
	CONSTRAINT "ccc_profiles_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
	CONSTRAINT "ccc_profiles_revision_ck" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."principal_purchase_limit_overrides" (
	"principal_purchase_limit_override_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"counterparty_purchasing_profile_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"policy_kind" text NOT NULL,
	"amount" numeric(38,18),
	"currency_code" text,
	"revision" integer NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_limit_overrides_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","principal_purchase_limit_override_id"),
	CONSTRAINT "ccc_limit_overrides_pair_revision_uk" UNIQUE("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","principal_id","revision"),
	CONSTRAINT "ccc_limit_overrides_value_ck" CHECK (("policy_kind" = 'UNLIMITED' and "amount" is null and "currency_code" is null) or ("policy_kind" = 'MONETARY_LIMIT' and "amount" is not null and "amount" >= 0 and "currency_code" ~ '^[A-Z]{3}$')),
	CONSTRAINT "ccc_limit_overrides_current_ck" CHECK (("is_current" and "superseded_at" is null) or (not "is_current" and "superseded_at" is not null)),
	CONSTRAINT "ccc_limit_overrides_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_limit_overrides_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."principal_purchase_limit_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."profile_reconciliation_cases" (
	"profile_reconciliation_case_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"profile_kind" text NOT NULL,
	"source_profile_id" uuid NOT NULL,
	"colliding_profile_id" uuid NOT NULL,
	"canonical_party_resource_id" text NOT NULL,
	"merge_resource_id" text NOT NULL,
	"lifecycle" text DEFAULT 'OPEN' NOT NULL,
	"resolution_kind" text,
	"canonical_profile_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_reconciliation_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","profile_reconciliation_case_id"),
	CONSTRAINT "ccc_reconciliation_distinct_profiles_ck" CHECK ("source_profile_id" <> "colliding_profile_id"),
	CONSTRAINT "ccc_reconciliation_kind_ck" CHECK ("profile_kind" in ('RETAIL', 'COUNTERPARTY')),
	CONSTRAINT "ccc_reconciliation_lifecycle_ck" CHECK ("lifecycle" in ('OPEN', 'NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED')),
	CONSTRAINT "ccc_reconciliation_resolution_ck" CHECK (("lifecycle" in ('OPEN', 'NEEDS_EVIDENCE') and "resolution_kind" is null and "canonical_profile_id" is null and "resolved_at" is null) or ("lifecycle" in ('RESOLVED', 'DISMISSED') and "resolution_kind" in ('SELECT_CANONICAL', 'KEEP_DISTINCT', 'DEFERRED') and "resolved_at" is not null)),
	CONSTRAINT "ccc_reconciliation_party_ref_ck" CHECK ("canonical_party_resource_id" = btrim("canonical_party_resource_id") and length("canonical_party_resource_id") > 0),
	CONSTRAINT "ccc_reconciliation_merge_ref_ck" CHECK ("merge_resource_id" = btrim("merge_resource_id") and length("merge_resource_id") > 0),
	CONSTRAINT "ccc_reconciliation_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_reconciliation_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."retail_customer_profiles" (
	"retail_customer_profile_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"party_resource_id" text NOT NULL,
	"party_resource_revision" text,
	"attribution_kind" text DEFAULT 'AUTHENTICATED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_retail_profiles_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","retail_customer_profile_id"),
	CONSTRAINT "ccc_retail_profiles_business_key_uk" UNIQUE("tenant_id","legal_entity_id","party_resource_id"),
	CONSTRAINT "ccc_retail_profiles_party_ref_ck" CHECK ("party_resource_id" = btrim("party_resource_id") and length("party_resource_id") > 0),
	CONSTRAINT "ccc_retail_profiles_party_revision_ck" CHECK ("party_resource_revision" is null or ("party_resource_revision" = btrim("party_resource_revision") and length("party_resource_revision") > 0)),
	CONSTRAINT "ccc_retail_profiles_attribution_ck" CHECK ("attribution_kind" in ('AUTHENTICATED', 'GUEST_ACCEPTANCE', 'RECONCILED'))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_customer_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."retail_portal_profile_bindings" (
	"retail_portal_profile_binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"retail_customer_profile_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"auth_binding_id" uuid NOT NULL,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_portal_bindings_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","retail_portal_profile_binding_id"),
	CONSTRAINT "ccc_portal_bindings_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'REVOKED') and (("lifecycle" = 'ACTIVE' and "revoked_at" is null) or ("lifecycle" = 'REVOKED' and "revoked_at" is not null))),
	CONSTRAINT "ccc_portal_bindings_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_portal_bindings_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."saved_addresses" (
	"saved_address_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"party_contact_point_resource_id" text,
	"party_contact_point_revision" text,
	"recipient_name" text,
	"organization_name" text,
	"address_line_1" text,
	"address_line_2" text,
	"locality" text,
	"administrative_area" text,
	"postal_code" text,
	"country_code" text,
	"phone_number" text,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_action_invocation_id" uuid NOT NULL,
	"last_actor_principal_id" uuid NOT NULL,
	"last_reason" text,
	CONSTRAINT "ccc_saved_addresses_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","saved_address_id"),
	CONSTRAINT "ccc_saved_addresses_source_kind_ck" CHECK ("source_kind" in ('PARTY_BACKED', 'COMMERCE_ONLY')),
	CONSTRAINT "ccc_saved_addresses_source_shape_ck" CHECK (("source_kind" = 'PARTY_BACKED' and "party_contact_point_resource_id" is not null and "address_line_1" is null and "locality" is null and "postal_code" is null and "country_code" is null) or ("source_kind" = 'COMMERCE_ONLY' and "party_contact_point_resource_id" is null and "party_contact_point_revision" is null and "address_line_1" is not null and "locality" is not null and "postal_code" is not null and "country_code" is not null)),
	CONSTRAINT "ccc_saved_addresses_country_ck" CHECK ("country_code" is null or "country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "ccc_saved_addresses_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'REMOVED') and (("lifecycle" = 'ACTIVE' and "removed_at" is null) or ("lifecycle" = 'REMOVED' and "removed_at" is not null))),
	CONSTRAINT "ccc_saved_addresses_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_saved_addresses_party_ref_ck" CHECK ("party_contact_point_resource_id" is null or ("party_contact_point_resource_id" = btrim("party_contact_point_resource_id") and length("party_contact_point_resource_id") > 0)),
	CONSTRAINT "ccc_saved_addresses_party_revision_ck" CHECK ("party_contact_point_revision" is null or ("party_contact_point_revision" = btrim("party_contact_point_revision") and length("party_contact_point_revision") > 0)),
	CONSTRAINT "ccc_saved_addresses_recipient_ck" CHECK ("recipient_name" is null or ("recipient_name" = btrim("recipient_name") and length("recipient_name") > 0)),
	CONSTRAINT "ccc_saved_addresses_organization_ck" CHECK ("organization_name" is null or ("organization_name" = btrim("organization_name") and length("organization_name") > 0)),
	CONSTRAINT "ccc_saved_addresses_line1_ck" CHECK ("address_line_1" is null or ("address_line_1" = btrim("address_line_1") and length("address_line_1") > 0)),
	CONSTRAINT "ccc_saved_addresses_line2_ck" CHECK ("address_line_2" is null or ("address_line_2" = btrim("address_line_2") and length("address_line_2") > 0)),
	CONSTRAINT "ccc_saved_addresses_locality_ck" CHECK ("locality" is null or ("locality" = btrim("locality") and length("locality") > 0)),
	CONSTRAINT "ccc_saved_addresses_area_ck" CHECK ("administrative_area" is null or ("administrative_area" = btrim("administrative_area") and length("administrative_area") > 0)),
	CONSTRAINT "ccc_saved_addresses_postal_ck" CHECK ("postal_code" is null or ("postal_code" = btrim("postal_code") and length("postal_code") > 0)),
	CONSTRAINT "ccc_saved_addresses_phone_ck" CHECK ("phone_number" is null or ("phone_number" = btrim("phone_number") and length("phone_number") > 0)),
	CONSTRAINT "ccc_saved_addresses_reason_ck" CHECK ("last_reason" is null or ("last_reason" = btrim("last_reason") and length("last_reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_access_invitations_pending_email_uk" ON "commerce_customer_context"."counterparty_access_invitations" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","invitee_email_hash") WHERE "lifecycle" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_access_grants_current_uk" ON "commerce_customer_context"."counterparty_commerce_access_grants" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","principal_id","permission_code","storefront_resource_id") WHERE "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_limit_defaults_current_uk" ON "commerce_customer_context"."counterparty_purchase_limit_defaults" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") WHERE "is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_address_defaults_current_uk" ON "commerce_customer_context"."customer_address_defaults" ("tenant_id","legal_entity_id","customer_profile_id","default_kind") WHERE "is_current" and "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_currency_preferences_current_uk" ON "commerce_customer_context"."customer_currency_preferences" ("tenant_id","legal_entity_id","customer_profile_id") WHERE "is_current" and "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_memberships_current_uk" ON "commerce_customer_context"."customer_group_memberships" ("tenant_id","legal_entity_id","customer_profile_id","customer_group_id") WHERE "is_current" and "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "ccc_memberships_effective_idx" ON "commerce_customer_context"."customer_group_memberships" ("tenant_id","legal_entity_id","customer_profile_id","effective_from","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_payment_entitlements_current_term_uk" ON "commerce_customer_context"."customer_payment_term_entitlements" ("tenant_id","legal_entity_id","customer_profile_id","payment_term_resource_id") WHERE "is_current" and "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_payment_entitlements_current_preference_uk" ON "commerce_customer_context"."customer_payment_term_entitlements" ("tenant_id","legal_entity_id","customer_profile_id") WHERE "is_current" and "lifecycle" = 'ACTIVE' and "is_preferred";--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_price_assignments_current_uk" ON "commerce_customer_context"."customer_price_group_assignments" ("tenant_id","legal_entity_id","customer_profile_id") WHERE "is_current" and "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_limit_overrides_current_uk" ON "commerce_customer_context"."principal_purchase_limit_overrides" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","principal_id") WHERE "is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_reconciliation_open_pair_uk" ON "commerce_customer_context"."profile_reconciliation_cases" ("tenant_id","legal_entity_id","source_profile_id","colliding_profile_id","merge_resource_id") WHERE "lifecycle" in ('OPEN', 'NEEDS_EVIDENCE');--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_portal_bindings_current_profile_uk" ON "commerce_customer_context"."retail_portal_profile_bindings" ("tenant_id","legal_entity_id","retail_customer_profile_id") WHERE "lifecycle" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_portal_bindings_current_auth_uk" ON "commerce_customer_context"."retail_portal_profile_bindings" ("tenant_id","legal_entity_id","auth_binding_id") WHERE "lifecycle" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."access_mutation_journal" ADD CONSTRAINT "ccc_access_journal_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD CONSTRAINT "ccc_access_invitations_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_commerce_access_grants" ADD CONSTRAINT "ccc_access_grants_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchase_limit_defaults" ADD CONSTRAINT "ccc_limit_defaults_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" ADD CONSTRAINT "ccc_counterparty_profiles_parent_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" ADD CONSTRAINT "ccc_address_defaults_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" ADD CONSTRAINT "ccc_address_defaults_address_fk" FOREIGN KEY ("tenant_id","legal_entity_id","saved_address_id") REFERENCES "commerce_customer_context"."saved_addresses"("tenant_id","legal_entity_id","saved_address_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" ADD CONSTRAINT "ccc_currency_preferences_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" ADD CONSTRAINT "ccc_memberships_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" ADD CONSTRAINT "ccc_memberships_group_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_group_id") REFERENCES "commerce_customer_context"."customer_groups"("tenant_id","legal_entity_id","customer_group_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD CONSTRAINT "ccc_group_revisions_group_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_group_id") REFERENCES "commerce_customer_context"."customer_groups"("tenant_id","legal_entity_id","customer_group_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" ADD CONSTRAINT "ccc_payment_entitlements_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_profile_lifecycle_history" ADD CONSTRAINT "ccc_profile_history_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."principal_purchase_limit_overrides" ADD CONSTRAINT "ccc_limit_overrides_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","legal_entity_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_source_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","source_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_collision_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","colliding_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_cases" ADD CONSTRAINT "ccc_reconciliation_canonical_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","canonical_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_customer_profiles" ADD CONSTRAINT "ccc_retail_profiles_parent_fk" FOREIGN KEY ("tenant_id","legal_entity_id","retail_customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."retail_portal_profile_bindings" ADD CONSTRAINT "ccc_portal_bindings_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","retail_customer_profile_id") REFERENCES "commerce_customer_context"."retail_customer_profiles"("tenant_id","legal_entity_id","retail_customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD CONSTRAINT "ccc_saved_addresses_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "ccc_access_journal_scope_select" ON "commerce_customer_context"."access_mutation_journal" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."access_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."access_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_journal_scope_insert" ON "commerce_customer_context"."access_mutation_journal" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."access_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."access_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_journal_scope_update" ON "commerce_customer_context"."access_mutation_journal" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."access_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."access_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."access_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."access_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_journal_scope_delete" ON "commerce_customer_context"."access_mutation_journal" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."access_mutation_journal"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."access_mutation_journal"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_invitations_scope_select" ON "commerce_customer_context"."counterparty_access_invitations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_access_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_access_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_invitations_scope_insert" ON "commerce_customer_context"."counterparty_access_invitations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."counterparty_access_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_access_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_invitations_scope_update" ON "commerce_customer_context"."counterparty_access_invitations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_access_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_access_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_access_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_access_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_invitations_scope_delete" ON "commerce_customer_context"."counterparty_access_invitations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_access_invitations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_access_invitations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_grants_scope_select" ON "commerce_customer_context"."counterparty_commerce_access_grants" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_commerce_access_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_commerce_access_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_grants_scope_insert" ON "commerce_customer_context"."counterparty_commerce_access_grants" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."counterparty_commerce_access_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_commerce_access_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_grants_scope_update" ON "commerce_customer_context"."counterparty_commerce_access_grants" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_commerce_access_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_commerce_access_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_commerce_access_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_commerce_access_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_access_grants_scope_delete" ON "commerce_customer_context"."counterparty_commerce_access_grants" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_commerce_access_grants"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_commerce_access_grants"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_defaults_scope_select" ON "commerce_customer_context"."counterparty_purchase_limit_defaults" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_purchase_limit_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchase_limit_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_defaults_scope_insert" ON "commerce_customer_context"."counterparty_purchase_limit_defaults" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."counterparty_purchase_limit_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchase_limit_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_defaults_scope_update" ON "commerce_customer_context"."counterparty_purchase_limit_defaults" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_purchase_limit_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchase_limit_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_purchase_limit_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchase_limit_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_defaults_scope_delete" ON "commerce_customer_context"."counterparty_purchase_limit_defaults" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_purchase_limit_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchase_limit_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_counterparty_profiles_scope_select" ON "commerce_customer_context"."counterparty_purchasing_profiles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_purchasing_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchasing_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_counterparty_profiles_scope_insert" ON "commerce_customer_context"."counterparty_purchasing_profiles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."counterparty_purchasing_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchasing_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_counterparty_profiles_scope_update" ON "commerce_customer_context"."counterparty_purchasing_profiles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_purchasing_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchasing_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."counterparty_purchasing_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchasing_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_counterparty_profiles_scope_delete" ON "commerce_customer_context"."counterparty_purchasing_profiles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."counterparty_purchasing_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."counterparty_purchasing_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_defaults_scope_select" ON "commerce_customer_context"."customer_address_defaults" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_address_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_address_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_defaults_scope_insert" ON "commerce_customer_context"."customer_address_defaults" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_address_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_address_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_defaults_scope_update" ON "commerce_customer_context"."customer_address_defaults" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_address_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_address_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_address_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_address_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_address_defaults_scope_delete" ON "commerce_customer_context"."customer_address_defaults" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_address_defaults"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_address_defaults"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_currency_preferences_scope_select" ON "commerce_customer_context"."customer_currency_preferences" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_currency_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_currency_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_currency_preferences_scope_insert" ON "commerce_customer_context"."customer_currency_preferences" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_currency_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_currency_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_currency_preferences_scope_update" ON "commerce_customer_context"."customer_currency_preferences" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_currency_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_currency_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_currency_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_currency_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_currency_preferences_scope_delete" ON "commerce_customer_context"."customer_currency_preferences" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_currency_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_currency_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_memberships_scope_select" ON "commerce_customer_context"."customer_group_memberships" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_memberships_scope_insert" ON "commerce_customer_context"."customer_group_memberships" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_memberships_scope_update" ON "commerce_customer_context"."customer_group_memberships" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_memberships_scope_delete" ON "commerce_customer_context"."customer_group_memberships" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_memberships"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_memberships"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_revisions_scope_select" ON "commerce_customer_context"."customer_group_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_revisions_scope_insert" ON "commerce_customer_context"."customer_group_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_revisions_scope_update" ON "commerce_customer_context"."customer_group_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_revisions_scope_delete" ON "commerce_customer_context"."customer_group_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_groups_scope_select" ON "commerce_customer_context"."customer_groups" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_groups"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_groups_scope_insert" ON "commerce_customer_context"."customer_groups" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_groups"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_groups_scope_update" ON "commerce_customer_context"."customer_groups" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_groups"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_groups"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_groups_scope_delete" ON "commerce_customer_context"."customer_groups" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_groups"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_groups"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_entitlements_scope_select" ON "commerce_customer_context"."customer_payment_term_entitlements" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_payment_term_entitlements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_entitlements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_entitlements_scope_insert" ON "commerce_customer_context"."customer_payment_term_entitlements" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_payment_term_entitlements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_entitlements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_entitlements_scope_update" ON "commerce_customer_context"."customer_payment_term_entitlements" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_payment_term_entitlements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_entitlements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_payment_term_entitlements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_entitlements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_entitlements_scope_delete" ON "commerce_customer_context"."customer_payment_term_entitlements" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_payment_term_entitlements"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_entitlements"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_price_assignments_scope_select" ON "commerce_customer_context"."customer_price_group_assignments" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_price_group_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_price_group_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_price_assignments_scope_insert" ON "commerce_customer_context"."customer_price_group_assignments" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_price_group_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_price_group_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_price_assignments_scope_update" ON "commerce_customer_context"."customer_price_group_assignments" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_price_group_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_price_group_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_price_group_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_price_group_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_price_assignments_scope_delete" ON "commerce_customer_context"."customer_price_group_assignments" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_price_group_assignments"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_price_group_assignments"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_history_scope_select" ON "commerce_customer_context"."customer_profile_lifecycle_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_lifecycle_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_lifecycle_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_history_scope_insert" ON "commerce_customer_context"."customer_profile_lifecycle_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profile_lifecycle_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_lifecycle_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_history_scope_update" ON "commerce_customer_context"."customer_profile_lifecycle_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_lifecycle_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_lifecycle_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profile_lifecycle_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_lifecycle_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profile_history_scope_delete" ON "commerce_customer_context"."customer_profile_lifecycle_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profile_lifecycle_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profile_lifecycle_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profiles_scope_select" ON "commerce_customer_context"."customer_profiles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profiles_scope_insert" ON "commerce_customer_context"."customer_profiles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profiles_scope_update" ON "commerce_customer_context"."customer_profiles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_profiles_scope_delete" ON "commerce_customer_context"."customer_profiles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_overrides_scope_select" ON "commerce_customer_context"."principal_purchase_limit_overrides" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."principal_purchase_limit_overrides"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."principal_purchase_limit_overrides"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_overrides_scope_insert" ON "commerce_customer_context"."principal_purchase_limit_overrides" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."principal_purchase_limit_overrides"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."principal_purchase_limit_overrides"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_overrides_scope_update" ON "commerce_customer_context"."principal_purchase_limit_overrides" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."principal_purchase_limit_overrides"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."principal_purchase_limit_overrides"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."principal_purchase_limit_overrides"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."principal_purchase_limit_overrides"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_limit_overrides_scope_delete" ON "commerce_customer_context"."principal_purchase_limit_overrides" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."principal_purchase_limit_overrides"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."principal_purchase_limit_overrides"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_scope_select" ON "commerce_customer_context"."profile_reconciliation_cases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_scope_insert" ON "commerce_customer_context"."profile_reconciliation_cases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."profile_reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_scope_update" ON "commerce_customer_context"."profile_reconciliation_cases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."profile_reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_reconciliation_scope_delete" ON "commerce_customer_context"."profile_reconciliation_cases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."profile_reconciliation_cases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."profile_reconciliation_cases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_retail_profiles_scope_select" ON "commerce_customer_context"."retail_customer_profiles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."retail_customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_retail_profiles_scope_insert" ON "commerce_customer_context"."retail_customer_profiles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."retail_customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_retail_profiles_scope_update" ON "commerce_customer_context"."retail_customer_profiles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."retail_customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."retail_customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_retail_profiles_scope_delete" ON "commerce_customer_context"."retail_customer_profiles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."retail_customer_profiles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_customer_profiles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_bindings_scope_select" ON "commerce_customer_context"."retail_portal_profile_bindings" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_bindings_scope_insert" ON "commerce_customer_context"."retail_portal_profile_bindings" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."retail_portal_profile_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_bindings_scope_update" ON "commerce_customer_context"."retail_portal_profile_bindings" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."retail_portal_profile_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_portal_bindings_scope_delete" ON "commerce_customer_context"."retail_portal_profile_bindings" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."retail_portal_profile_bindings"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."retail_portal_profile_bindings"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_saved_addresses_scope_select" ON "commerce_customer_context"."saved_addresses" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."saved_addresses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."saved_addresses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_saved_addresses_scope_insert" ON "commerce_customer_context"."saved_addresses" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."saved_addresses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."saved_addresses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_saved_addresses_scope_update" ON "commerce_customer_context"."saved_addresses" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."saved_addresses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."saved_addresses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."saved_addresses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."saved_addresses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_saved_addresses_scope_delete" ON "commerce_customer_context"."saved_addresses" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."saved_addresses"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."saved_addresses"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
-- Effective periods are half-open. Adjacent periods are valid, overlapping facts are not.
ALTER TABLE "commerce_customer_context"."customer_group_memberships"
ADD CONSTRAINT "ccc_memberships_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_profile_id" WITH =,
  "customer_group_id" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("lifecycle" in ('ACTIVE', 'ENDED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments"
ADD CONSTRAINT "ccc_price_assignments_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_profile_id" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("lifecycle" in ('ACTIVE', 'ENDED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences"
ADD CONSTRAINT "ccc_currency_preferences_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_profile_id" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("lifecycle" in ('ACTIVE', 'ENDED', 'CLEARED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements"
ADD CONSTRAINT "ccc_payment_entitlements_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_profile_id" WITH =,
  "payment_term_resource_id" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("lifecycle" in ('ACTIVE', 'ENDED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults"
ADD CONSTRAINT "ccc_address_defaults_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_profile_id" WITH =,
  "default_kind" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("lifecycle" in ('ACTIVE', 'ENDED'));
--> statement-breakpoint
-- Historical evidence is append-only. Corrective meaning is represented by a new revision.
CREATE FUNCTION "commerce_customer_context"."reject_append_only_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Commerce Customer Context history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ccc_profile_history_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."customer_profile_lifecycle_history"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ccc_group_revisions_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."customer_group_revisions"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ccc_access_journal_append_only"
BEFORE UPDATE OR DELETE ON "commerce_customer_context"."access_mutation_journal"
FOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();
--> statement-breakpoint
-- The owner migration role keeps raw-table ownership. Runtime access is granted only through
-- audited owner routines/views; the initial foundation intentionally exposes none.
REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON FUNCTION "commerce_customer_context"."reject_append_only_mutation"() FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE CREATE ON SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "commerce_customer_context" TO "ontos_runtime";
--> statement-breakpoint
-- FORCE RLS is not emitted by Drizzle Kit. Every governed owner table must keep it enabled.
DO $$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'access_mutation_journal',
    'counterparty_access_invitations',
    'counterparty_commerce_access_grants',
    'counterparty_purchase_limit_defaults',
    'counterparty_purchasing_profiles',
    'customer_address_defaults',
    'customer_currency_preferences',
    'customer_group_memberships',
    'customer_group_revisions',
    'customer_groups',
    'customer_payment_term_entitlements',
    'customer_price_group_assignments',
    'customer_profile_lifecycle_history',
    'customer_profiles',
    'principal_purchase_limit_overrides',
    'profile_reconciliation_cases',
    'retail_customer_profiles',
    'retail_portal_profile_bindings',
    'saved_addresses'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE commerce_customer_context.%I FORCE ROW LEVEL SECURITY',
      relation_name
    );
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Migration-time assertion: accidentally granting a raw table to the runtime role is a release
-- blocker. Governed access must be added as an explicit routine/view in a later migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'commerce_customer_context'
      AND relation.relkind IN ('r', 'p')
      AND (
        has_table_privilege('ontos_runtime', relation.oid, 'SELECT')
        OR has_table_privilege('ontos_runtime', relation.oid, 'INSERT')
        OR has_table_privilege('ontos_runtime', relation.oid, 'UPDATE')
        OR has_table_privilege('ontos_runtime', relation.oid, 'DELETE')
      )
  ) THEN
    RAISE EXCEPTION 'ontos_runtime must not hold raw Commerce Customer Context table privileges';
  END IF;
END;
$$;
