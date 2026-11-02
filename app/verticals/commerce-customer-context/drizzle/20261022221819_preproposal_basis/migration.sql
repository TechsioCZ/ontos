CREATE TABLE "commerce_customer_context"."purchase_proposal_bases" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"basis_id" uuid,
	"buyer_principal_id" uuid NOT NULL,
	"intent_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"encoded_basis" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_proposal_bases_pk" PRIMARY KEY("tenant_id","legal_entity_id","basis_id"),
	CONSTRAINT "ccc_proposal_bases_intent_uk" UNIQUE("tenant_id","legal_entity_id","buyer_principal_id","intent_key")
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."purchase_proposal_bases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ccc_proposal_bases_select" ON "commerce_customer_context"."purchase_proposal_bases" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_proposal_bases_insert" ON "commerce_customer_context"."purchase_proposal_bases" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_proposal_bases_update" ON "commerce_customer_context"."purchase_proposal_bases" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_proposal_bases_delete" ON "commerce_customer_context"."purchase_proposal_bases" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_proposal_bases_owner_routine" ON "commerce_customer_context"."purchase_proposal_bases" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."purchase_proposal_bases"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."purchase_proposal_bases"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);