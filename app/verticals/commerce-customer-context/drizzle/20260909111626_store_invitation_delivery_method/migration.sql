ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD COLUMN "delivery_method" text DEFAULT 'VERIFIED_CONTACT_POINT' NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ALTER COLUMN "delivery_method" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."counterparty_access_invitations" ADD CONSTRAINT "ccc_access_invitations_delivery_method_ck" CHECK ("delivery_method" in ('VERIFIED_CONTACT_POINT', 'APPROVED_RECIPIENT_DISCOVERY'));
