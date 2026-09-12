-- Coherent snapshot reconciliation for Customer Group descriptions, exact Purchase Limit scale,
-- and the invitation claim lifecycle already introduced by the preceding custom owner migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "commerce_customer_context"."counterparty_purchase_limit_defaults"
    WHERE "amount" IS NOT NULL AND "amount" <> trunc("amount", 9)
  ) OR EXISTS (
    SELECT 1
    FROM "commerce_customer_context"."principal_purchase_limit_overrides"
    WHERE "amount" IS NOT NULL AND "amount" <> trunc("amount", 9)
  ) THEN
    RAISE EXCEPTION 'Purchase Limit amount exceeds the supported 9-digit fractional scale'
      USING ERRCODE = '22003';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD COLUMN "description" text;--> statement-breakpoint
UPDATE "commerce_customer_context"."customer_group_revisions"
SET "description" = "display_name"
WHERE "description" IS NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ALTER COLUMN "description" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchase_limit_defaults" ALTER COLUMN "amount" SET DATA TYPE numeric(38,9) USING "amount"::numeric(38,9);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."principal_purchase_limit_overrides" ALTER COLUMN "amount" SET DATA TYPE numeric(38,9) USING "amount"::numeric(38,9);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_revisions" ADD CONSTRAINT "ccc_group_revisions_description_ck" CHECK ("description" = btrim("description") and length("description") > 0);--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" DROP CONSTRAINT "ccc_access_invitations_claim_ck", ADD CONSTRAINT "ccc_access_invitations_claim_ck" CHECK (("lifecycle" = 'CLAIMED' and "claimed_by_principal_id" is not null and "claimed_at" is not null) or ("lifecycle" in ('CLAIMING', 'RECONCILIATION_REQUIRED') and "claimed_by_principal_id" is not null and "claimed_at" is null) or ("lifecycle" in ('PENDING', 'EXPIRED') and "claimed_by_principal_id" is null and "claimed_at" is null) or ("lifecycle" = 'REVOKED' and "claimed_at" is null));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_purchase_limit_defaults" DROP CONSTRAINT "ccc_limit_defaults_value_ck", ADD CONSTRAINT "ccc_limit_defaults_value_ck" CHECK (("policy_kind" in ('UNLIMITED', 'CLEARED') and "amount" is null and "currency_code" is null) or ("policy_kind" = 'MONETARY_LIMIT' and "amount" is not null and "amount" >= 0 and "currency_code" ~ '^[A-Z]{3}$'));--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."principal_purchase_limit_overrides" DROP CONSTRAINT "ccc_limit_overrides_value_ck", ADD CONSTRAINT "ccc_limit_overrides_value_ck" CHECK (("policy_kind" in ('UNLIMITED', 'CLEARED') and "amount" is null and "currency_code" is null) or ("policy_kind" = 'MONETARY_LIMIT' and "amount" is not null and "amount" >= 0 and "currency_code" ~ '^[A-Z]{3}$'));
