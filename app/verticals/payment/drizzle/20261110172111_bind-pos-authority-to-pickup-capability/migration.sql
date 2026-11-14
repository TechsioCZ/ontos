ALTER TABLE "payment"."source_authorities" ADD COLUMN "pickup_capability_ref" text;--> statement-breakpoint
ALTER TABLE "payment"."source_authorities" DROP CONSTRAINT "payment_source_authorities_identity_uk";--> statement-breakpoint
ALTER TABLE "payment"."source_authorities" ADD CONSTRAINT "payment_source_authorities_identity_uk" UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","fact_family","method","pickup_capability_ref","source_kind","source_system","account_ref","environment");--> statement-breakpoint
ALTER TABLE "payment"."source_authorities" ADD CONSTRAINT "payment_source_authorities_pickup_capability_ck" CHECK ("pickup_capability_ref" is null or ("source_kind" = 'LOCAL_POS_OPERATOR'
        and "pickup_capability_ref" = btrim("pickup_capability_ref")
        and length("pickup_capability_ref") between 1 and 200));