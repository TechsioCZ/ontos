CREATE TABLE "commerce_customer_context"."customer_group_lifecycle_periods" (
	"customer_group_lifecycle_period_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_group_id" uuid NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_group_lifecycle_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_lifecycle_period_id"),
	CONSTRAINT "ccc_group_lifecycle_revision_uk" UNIQUE("tenant_id","legal_entity_id","customer_group_id","revision"),
	CONSTRAINT "ccc_group_lifecycle_period_ck" CHECK ("archived_at" is null or "archived_at" > "active_from"),
	CONSTRAINT "ccc_group_lifecycle_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_group_lifecycle_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_lifecycle_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_payment_term_preferences" (
	"customer_payment_term_preference_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"payment_term_resource_id" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"lifecycle" text DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_payment_preferences_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_payment_term_preference_id"),
	CONSTRAINT "ccc_payment_preferences_term_ref_ck" CHECK ("payment_term_resource_id" = btrim("payment_term_resource_id") and length("payment_term_resource_id") > 0),
	CONSTRAINT "ccc_payment_preferences_period_ck" CHECK ("effective_to" is null or "effective_to" > "effective_from"),
	CONSTRAINT "ccc_payment_preferences_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED') and ("lifecycle" <> 'ENDED' or "effective_to" is not null)),
	CONSTRAINT "ccc_payment_preferences_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "ccc_payment_preferences_reason_ck" CHECK ("reason" is null or ("reason" = btrim("reason") and length("reason") > 0))
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_customer_context"."customer_setting_revisions" (
	"customer_setting_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"setting_kind" text NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"last_action_invocation_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_setting_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","customer_setting_revision_id"),
	CONSTRAINT "ccc_setting_revisions_profile_kind_uk" UNIQUE("tenant_id","legal_entity_id","customer_profile_id","setting_kind"),
	CONSTRAINT "ccc_setting_revisions_kind_ck" CHECK ("setting_kind" in ('ADDRESS_DEFAULTS', 'CURRENCY', 'GROUP_MEMBERSHIP', 'PAYMENT_TERMS', 'PRICE_GROUP')),
	CONSTRAINT "ccc_setting_revisions_revision_ck" CHECK ("current_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_setting_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_token_hash_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" DROP CONSTRAINT "ccc_address_defaults_profile_revision_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" DROP CONSTRAINT "ccc_currency_preferences_profile_revision_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" DROP CONSTRAINT "ccc_payment_entitlements_profile_revision_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_email_hash_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_token_hash_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" DROP CONSTRAINT "ccc_group_revisions_description_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP CONSTRAINT "ccc_price_assignments_revision_ref_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP CONSTRAINT "ccc_price_assignments_current_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" DROP CONSTRAINT "ccc_saved_addresses_party_revision_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" DROP CONSTRAINT "ccc_address_defaults_current_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" DROP CONSTRAINT "ccc_currency_preferences_current_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" DROP CONSTRAINT "ccc_memberships_current_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" DROP CONSTRAINT "ccc_payment_entitlements_current_ck";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" DROP CONSTRAINT "ccc_payment_entitlements_preferred_ck";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_access_invitations_pending_email_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_address_defaults_current_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_currency_preferences_current_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_memberships_current_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_payment_entitlements_current_term_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_payment_entitlements_current_preference_uk";--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_price_assignments_current_uk";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD COLUMN "delivery_reference" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD COLUMN "claim_proof_reference" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD COLUMN "purpose" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD COLUMN "membership_criteria" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD COLUMN "change_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_groups" ADD COLUMN "meaning_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "price_group_module_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "price_group_resource_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "catalog_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "compatibility_contract_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "compatibility_contract_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "definition_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD COLUMN "purposes" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD COLUMN "party_resource_id" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP COLUMN "invitee_email_hash";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP COLUMN "price_group_revision";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP COLUMN "contract_compatibility_key";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP COLUMN "is_current";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" DROP COLUMN "is_current";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" DROP COLUMN "is_current";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" DROP COLUMN "is_current";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" DROP COLUMN "is_current";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" DROP COLUMN "is_preferred";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" ALTER COLUMN "lifecycle" SET DEFAULT 'PENDING_GRANT';--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" ALTER COLUMN "currency_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ALTER COLUMN "party_contact_point_revision" SET DATA TYPE integer USING "party_contact_point_revision"::integer;--> statement-breakpoint
DROP INDEX "commerce_customer_context"."ccc_access_grants_current_uk";--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_access_grants_current_uk" ON "commerce_customer_context"."counterparty_commerce_access_grants" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","principal_id","permission_code","storefront_resource_id") WHERE "lifecycle" in ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'RECONCILIATION_REQUIRED');--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_access_invitations_pending_delivery_uk" ON "commerce_customer_context"."counterparty_access_invitations" ("tenant_id","legal_entity_id","counterparty_purchasing_profile_id","delivery_reference") WHERE "lifecycle" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_group_lifecycle_open_uk" ON "commerce_customer_context"."customer_group_lifecycle_periods" ("tenant_id","legal_entity_id","customer_group_id") WHERE "archived_at" is null;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_lifecycle_periods" ADD CONSTRAINT "ccc_group_lifecycle_group_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_group_id") REFERENCES "commerce_customer_context"."customer_groups"("tenant_id","legal_entity_id","customer_group_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_preferences" ADD CONSTRAINT "ccc_payment_preferences_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_setting_revisions" ADD CONSTRAINT "ccc_setting_revisions_profile_fk" FOREIGN KEY ("tenant_id","legal_entity_id","customer_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","legal_entity_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD CONSTRAINT "ccc_access_invitations_delivery_ref_ck" CHECK ("delivery_reference" = btrim("delivery_reference") and length("delivery_reference") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD CONSTRAINT "ccc_access_invitations_claim_proof_ck" CHECK ("claim_proof_reference" is null or ("claim_proof_reference" = btrim("claim_proof_reference") and length("claim_proof_reference") > 0));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD CONSTRAINT "ccc_group_revisions_purpose_ck" CHECK ("purpose" = btrim("purpose") and length("purpose") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD CONSTRAINT "ccc_group_revisions_criteria_ck" CHECK ("membership_criteria" = btrim("membership_criteria") and length("membership_criteria") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD CONSTRAINT "ccc_group_revisions_change_kind_ck" CHECK ("change_kind" in ('CREATED', 'COSMETIC_RENAME', 'TYPO_CORRECTION', 'DESCRIPTION_CLARIFICATION'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_groups" ADD CONSTRAINT "ccc_groups_meaning_key_ck" CHECK ("meaning_key" ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$');--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_module_ref_ck" CHECK ("price_group_module_id" = btrim("price_group_module_id") and length("price_group_module_id") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_type_ref_ck" CHECK ("price_group_resource_type" = btrim("price_group_resource_type") and length("price_group_resource_type") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_catalog_revision_ck" CHECK ("catalog_revision" > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_contract_revision_ck" CHECK ("compatibility_contract_revision" > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_definition_revision_ck" CHECK ("definition_revision" > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD CONSTRAINT "ccc_saved_addresses_purposes_ck" CHECK (jsonb_typeof("purposes") = 'array' and jsonb_array_length("purposes") between 1 and 2 and "purposes" <@ '["BILLING", "DELIVERY"]'::jsonb);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD CONSTRAINT "ccc_saved_addresses_label_ck" CHECK ("label" is null or ("label" = btrim("label") and length("label") > 0));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" ADD CONSTRAINT "ccc_saved_addresses_party_owner_ref_ck" CHECK ("party_resource_id" is null or ("party_resource_id" = btrim("party_resource_id") and length("party_resource_id") > 0));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_lifecycle_ck", ADD CONSTRAINT "ccc_access_invitations_lifecycle_ck" CHECK ("lifecycle" in ('PENDING', 'CLAIMING', 'CLAIMED', 'REVOKED', 'EXPIRED', 'RECONCILIATION_REQUIRED'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_commerce_access_grants" DROP CONSTRAINT "ccc_access_grants_lifecycle_ck", ADD CONSTRAINT "ccc_access_grants_lifecycle_ck" CHECK ("lifecycle" in ('PENDING_GRANT', 'ACTIVE', 'PENDING_REVOKE', 'REVOKED', 'RECONCILIATION_REQUIRED') and (("lifecycle" = 'REVOKED' and "revoked_at" is not null) or ("lifecycle" <> 'REVOKED' and "revoked_at" is null)));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_address_defaults" DROP CONSTRAINT "ccc_address_defaults_lifecycle_ck", ADD CONSTRAINT "ccc_address_defaults_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED') and ("lifecycle" <> 'ENDED' or "effective_to" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" DROP CONSTRAINT "ccc_currency_preferences_code_ck", ADD CONSTRAINT "ccc_currency_preferences_code_ck" CHECK (("lifecycle" = 'ACTIVE' and "currency_code" ~ '^[A-Z]{3}$') or ("lifecycle" = 'CLEARED' and "currency_code" is null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_currency_preferences" DROP CONSTRAINT "ccc_currency_preferences_lifecycle_ck", ADD CONSTRAINT "ccc_currency_preferences_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CLEARED') and ("lifecycle" <> 'ENDED' or "effective_to" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_memberships" DROP CONSTRAINT "ccc_memberships_lifecycle_ck", ADD CONSTRAINT "ccc_memberships_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED') and ("lifecycle" <> 'ENDED' or "effective_to" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_groups" DROP CONSTRAINT "ccc_groups_code_format_ck", ADD CONSTRAINT "ccc_groups_code_format_ck" CHECK ("stable_code" ~ '^[A-Z][A-Z0-9_]{1,63}$');--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_entitlements" DROP CONSTRAINT "ccc_payment_entitlements_lifecycle_ck", ADD CONSTRAINT "ccc_payment_entitlements_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED') and ("lifecycle" <> 'ENDED' or "effective_to" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP CONSTRAINT IF EXISTS "ccc_price_assignments_compatibility_ck", ADD CONSTRAINT "ccc_price_assignments_compatibility_ck" CHECK ("compatibility_contract_id" = btrim("compatibility_contract_id") and length("compatibility_contract_id") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" DROP CONSTRAINT "ccc_price_assignments_lifecycle_ck", ADD CONSTRAINT "ccc_price_assignments_lifecycle_ck" CHECK ("lifecycle" in ('ACTIVE', 'ENDED', 'CANCELLED') and ("lifecycle" <> 'ENDED' or "effective_to" is not null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."saved_addresses" DROP CONSTRAINT "ccc_saved_addresses_source_shape_ck", ADD CONSTRAINT "ccc_saved_addresses_source_shape_ck" CHECK (("source_kind" = 'PARTY_BACKED' and "party_resource_id" is not null and "party_contact_point_resource_id" is not null and "party_contact_point_revision" > 0 and "address_line_1" is null and "locality" is null and "postal_code" is null and "country_code" is null) or ("source_kind" = 'COMMERCE_ONLY' and "party_resource_id" is null and "party_contact_point_resource_id" is null and "party_contact_point_revision" is null and "address_line_1" is not null and "locality" is not null and "postal_code" is not null and "country_code" is not null));--> statement-breakpoint
CREATE POLICY "ccc_group_lifecycle_scope_select" ON "commerce_customer_context"."customer_group_lifecycle_periods" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_lifecycle_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_lifecycle_scope_insert" ON "commerce_customer_context"."customer_group_lifecycle_periods" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_group_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_lifecycle_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_lifecycle_scope_update" ON "commerce_customer_context"."customer_group_lifecycle_periods" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_lifecycle_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_group_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_lifecycle_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_group_lifecycle_scope_delete" ON "commerce_customer_context"."customer_group_lifecycle_periods" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_group_lifecycle_periods"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_group_lifecycle_periods"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_preferences_scope_select" ON "commerce_customer_context"."customer_payment_term_preferences" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_payment_term_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_preferences_scope_insert" ON "commerce_customer_context"."customer_payment_term_preferences" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_payment_term_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_preferences_scope_update" ON "commerce_customer_context"."customer_payment_term_preferences" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_payment_term_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_payment_term_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_payment_preferences_scope_delete" ON "commerce_customer_context"."customer_payment_term_preferences" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_payment_term_preferences"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_payment_term_preferences"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_setting_revisions_scope_select" ON "commerce_customer_context"."customer_setting_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."customer_setting_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_setting_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_setting_revisions_scope_insert" ON "commerce_customer_context"."customer_setting_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."customer_setting_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_setting_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_setting_revisions_scope_update" ON "commerce_customer_context"."customer_setting_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."customer_setting_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_setting_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."customer_setting_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_setting_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_setting_revisions_scope_delete" ON "commerce_customer_context"."customer_setting_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."customer_setting_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."customer_setting_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_preferences"
ADD CONSTRAINT "ccc_payment_preferences_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_profile_id" WITH =,
  tstzrange("effective_from", coalesce("effective_to", 'infinity'::timestamptz), '[)') WITH &&
)
WHERE ("lifecycle" in ('ACTIVE', 'ENDED'));
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_lifecycle_periods"
ADD CONSTRAINT "ccc_group_lifecycle_no_overlap_excl"
EXCLUDE USING gist (
  "tenant_id" WITH =,
  "legal_entity_id" WITH =,
  "customer_group_id" WITH =,
  tstzrange("active_from", coalesce("archived_at", 'infinity'::timestamptz), '[)') WITH &&
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_lifecycle_periods" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_payment_term_preferences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_setting_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";
--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";
