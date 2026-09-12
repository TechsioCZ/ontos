-- Customer Currency Preference is a Later-only capability.  The append-only contraction keeps
-- historical migration files intact, removes only its live routines/table, and refuses to
-- narrow shared append-only ledgers while legacy evidence still exists.
DO $customer_currency_preference_retirement_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "commerce_customer_context"."customer_setting_revisions"
     WHERE "setting_kind" = 'CURRENCY'
  ) THEN
    RAISE EXCEPTION 'Cannot retire Customer Currency Preference: legacy CURRENCY setting revisions require explicit data retirement';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "commerce_customer_context"."profile_reconciliation_owner_outcomes"
     WHERE "owner" = 'CURRENCY_PREFERENCE'
  ) THEN
    RAISE EXCEPTION 'Cannot retire Customer Currency Preference: legacy CURRENCY_PREFERENCE owner outcomes are append-only evidence';
  END IF;
END
$customer_currency_preference_retirement_preflight$;--> statement-breakpoint
DROP FUNCTION IF EXISTS "commerce_customer_context"."read_currency_preference"(uuid, uuid, text, text, text);--> statement-breakpoint
DROP FUNCTION IF EXISTS "commerce_customer_context"."change_currency_preference"(uuid, uuid, text, text, text, integer, text, text, text[], uuid, uuid);--> statement-breakpoint
DROP FUNCTION IF EXISTS "commerce_customer_context"."verify_currency_preference_reconciliation_owner"(uuid, uuid, uuid, text, uuid, text, integer, bigint, timestamptz, uuid, uuid, text);--> statement-breakpoint
DROP POLICY "ccc_currency_preferences_scope_select" ON "commerce_customer_context"."customer_currency_preferences";--> statement-breakpoint
DROP POLICY "ccc_currency_preferences_scope_insert" ON "commerce_customer_context"."customer_currency_preferences";--> statement-breakpoint
DROP POLICY "ccc_currency_preferences_scope_update" ON "commerce_customer_context"."customer_currency_preferences";--> statement-breakpoint
DROP POLICY "ccc_currency_preferences_scope_delete" ON "commerce_customer_context"."customer_currency_preferences";--> statement-breakpoint
DROP POLICY "ccc_currency_preferences_scope_owner_routine" ON "commerce_customer_context"."customer_currency_preferences";--> statement-breakpoint
DROP TABLE "commerce_customer_context"."customer_currency_preferences";--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."access_mutation_journal" DROP CONSTRAINT "ccc_access_journal_profile_fk", ADD CONSTRAINT "ccc_access_journal_profile_fk" FOREIGN KEY ("tenant_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_profile_fk", ADD CONSTRAINT "ccc_access_invitations_profile_fk" FOREIGN KEY ("tenant_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_commerce_access_grants" DROP CONSTRAINT "ccc_access_grants_profile_fk", ADD CONSTRAINT "ccc_access_grants_profile_fk" FOREIGN KEY ("tenant_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchase_limit_defaults" DROP CONSTRAINT "ccc_limit_defaults_profile_fk", ADD CONSTRAINT "ccc_limit_defaults_profile_fk" FOREIGN KEY ("tenant_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchasing_profiles" DROP CONSTRAINT "ccc_counterparty_profiles_parent_fk", ADD CONSTRAINT "ccc_counterparty_profiles_parent_fk" FOREIGN KEY ("tenant_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."customer_profiles"("tenant_id","customer_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."principal_purchase_limit_overrides" DROP CONSTRAINT "ccc_limit_overrides_profile_fk", ADD CONSTRAINT "ccc_limit_overrides_profile_fk" FOREIGN KEY ("tenant_id","counterparty_purchasing_profile_id") REFERENCES "commerce_customer_context"."counterparty_purchasing_profiles"("tenant_id","counterparty_purchasing_profile_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_setting_revisions" DROP CONSTRAINT "ccc_setting_revisions_kind_ck", ADD CONSTRAINT "ccc_setting_revisions_kind_ck" CHECK ("setting_kind" in ('ADDRESS_DEFAULTS', 'GROUP_MEMBERSHIP', 'PAYMENT_TERMS', 'PRICE_GROUP'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."profile_reconciliation_owner_outcomes" DROP CONSTRAINT "ccc_reconciliation_owner_outcomes_owner_ck", ADD CONSTRAINT "ccc_reconciliation_owner_outcomes_owner_ck" CHECK ("owner" in ('PROFILE_LIFECYCLE', 'CUSTOMER_GROUP_MEMBERSHIP', 'PRICE_GROUP_ASSIGNMENT', 'PAYMENT_TERMS', 'ADDRESS_BOOK', 'RETAIL_PORTAL_BINDING', 'COUNTERPARTY_ACCESS', 'PURCHASE_LIMITS', 'APPROVAL', 'CONNECTOR_CORRELATION'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_approval_requests" DROP CONSTRAINT "ccc_approval_requests_consumed_ck", ADD CONSTRAINT "ccc_approval_requests_consumed_ck" CHECK (("status" = 'CONSUMED' and "consumed_at" is not null and "committed_order_ref" is not null and "consumption_commitment_id" is not null) or ("status" <> 'CONSUMED' and "consumed_at" is null and "committed_order_ref" is null and "consumption_commitment_id" is null));
