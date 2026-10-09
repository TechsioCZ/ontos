ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "compatibility_trusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "compatibility_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "definition_effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "definition_effective_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "definition_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD COLUMN "meaning_fingerprint" text;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."customer_price_group_assignments" ADD CONSTRAINT "ccc_price_assignments_canonical_evidence_ck" CHECK ((
        "definition_revision_id" is null
        and "definition_effective_from" is null
        and "definition_effective_to" is null
        and "meaning_fingerprint" is null
        and "compatibility_trusted_at" is null
        and "compatibility_verified_at" is null
      ) or (
        "definition_revision_id" is not null
        and "definition_effective_from" is not null
        and ("definition_effective_to" is null or "definition_effective_to" > "definition_effective_from")
        and "meaning_fingerprint" ~ '^[0-9a-f]{64}$'
        and "compatibility_trusted_at" is not null
        and "compatibility_trusted_at" >= "definition_effective_from"
        and ("definition_effective_to" is null or "compatibility_trusted_at" < "definition_effective_to")
        and "compatibility_verified_at" is not null
        and "compatibility_verified_at" >= "compatibility_trusted_at"
      ));