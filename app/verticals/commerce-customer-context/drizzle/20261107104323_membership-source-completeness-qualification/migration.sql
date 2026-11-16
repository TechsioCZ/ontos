ALTER TABLE "commerce_customer_context"."customer_group_membership_snapshot_proofs" ADD COLUMN "completeness_contract_ref" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_snapshot_proofs" ADD COLUMN "completeness_contract_revision" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_snapshot_proofs" ADD COLUMN "completeness_contract_coverage" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_snapshot_proofs" ADD COLUMN "qualified_by_action_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_snapshot_proofs" ADD COLUMN "qualified_by_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_snapshot_proofs" ADD COLUMN "qualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_routes" ADD COLUMN "completeness_contract_ref" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_routes" ADD COLUMN "completeness_contract_revision" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_group_membership_source_routes" ADD COLUMN "completeness_contract_coverage" text;