CREATE SCHEMA "promotion";
--> statement-breakpoint
CREATE TABLE "promotion"."basis_policies" (
	"tenant_id" uuid PRIMARY KEY,
	"policy" jsonb NOT NULL,
	"version" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotion"."basis_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."gateway_assertion_redemptions" (
	"issuer" text,
	"audience" text,
	"jti" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE TABLE "promotion"."issued_proofs" (
	"tenant_id" uuid NOT NULL,
	"proof_id" uuid PRIMARY KEY,
	"generation" integer NOT NULL,
	"stage" text NOT NULL,
	"merchandise_proof_id" uuid,
	"binding" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "promotion_proof_tenant_identity" UNIQUE("tenant_id","proof_id"),
	CONSTRAINT "promotion_proof_stage_binding" CHECK (("stage" = 'MERCHANDISE' and "merchandise_proof_id" is null) or ("stage" = 'SHIPPING' and "merchandise_proof_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "promotion"."issued_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."lifecycle_facts" (
	"tenant_id" uuid NOT NULL,
	"fact_id" uuid PRIMARY KEY,
	"promotion_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "promotion_lifecycle_version" UNIQUE("tenant_id","promotion_id","version")
);
--> statement-breakpoint
ALTER TABLE "promotion"."lifecycle_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."promotion_drafts" (
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid PRIMARY KEY,
	"meaning" jsonb NOT NULL,
	"predecessor_promotion_id" uuid,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "promotion_draft_tenant_identity" UNIQUE("tenant_id","promotion_id"),
	CONSTRAINT "promotion_draft_version_positive" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "promotion"."promotion_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."published_promotions" (
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid PRIMARY KEY,
	"meaning" jsonb NOT NULL,
	"predecessor_promotion_id" uuid,
	"version" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "promotion_published_tenant_identity" UNIQUE("tenant_id","promotion_id")
);
--> statement-breakpoint
ALTER TABLE "promotion"."published_promotions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."selection_policies" (
	"tenant_id" uuid,
	"kind" text,
	"ordered_promotion_ids" jsonb NOT NULL,
	"version" integer NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "selection_policies_pkey" PRIMARY KEY("tenant_id","kind")
);
--> statement-breakpoint
ALTER TABLE "promotion"."selection_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."tenant_generations" (
	"tenant_id" uuid PRIMARY KEY,
	"generation" integer NOT NULL,
	CONSTRAINT "promotion_generation_positive" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "promotion"."tenant_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."voucher_disable_facts" (
	"tenant_id" uuid NOT NULL,
	"voucher_id" uuid PRIMARY KEY,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotion"."voucher_disable_facts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotion"."vouchers" (
	"tenant_id" uuid NOT NULL,
	"voucher_id" uuid PRIMARY KEY,
	"promotion_id" uuid NOT NULL,
	"normalized_code" text NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "promotion_voucher_tenant_identity" UNIQUE("tenant_id","voucher_id"),
	CONSTRAINT "promotion_voucher_code_permanent" UNIQUE("tenant_id","normalized_code"),
	CONSTRAINT "promotion_voucher_code_canonical" CHECK ("normalized_code" = lower(btrim("normalized_code")) and length("normalized_code") between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "promotion"."vouchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "promotion_redemption_expiry" ON "promotion"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
ALTER TABLE "promotion"."lifecycle_facts" ADD CONSTRAINT "promotion_lifecycle_tenant_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "promotion"."published_promotions"("tenant_id","promotion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "promotion"."published_promotions" ADD CONSTRAINT "promotion_publication_draft_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "promotion"."promotion_drafts"("tenant_id","promotion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "promotion"."published_promotions" ADD CONSTRAINT "promotion_successor_tenant_fk" FOREIGN KEY ("tenant_id","predecessor_promotion_id") REFERENCES "promotion"."promotion_drafts"("tenant_id","promotion_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "promotion"."voucher_disable_facts" ADD CONSTRAINT "promotion_voucher_disable_tenant_fk" FOREIGN KEY ("tenant_id","voucher_id") REFERENCES "promotion"."vouchers"("tenant_id","voucher_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "promotion"."vouchers" ADD CONSTRAINT "promotion_voucher_published_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "promotion"."published_promotions"("tenant_id","promotion_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "promotion_basis_policy_select" ON "promotion"."basis_policies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."basis_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_basis_policy_insert" ON "promotion"."basis_policies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."basis_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_basis_policy_update" ON "promotion"."basis_policies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."basis_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."basis_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_basis_policy_delete" ON "promotion"."basis_policies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."basis_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_issued_proof_select" ON "promotion"."issued_proofs" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."issued_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_issued_proof_insert" ON "promotion"."issued_proofs" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."issued_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_issued_proof_update" ON "promotion"."issued_proofs" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."issued_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."issued_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_issued_proof_delete" ON "promotion"."issued_proofs" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."issued_proofs"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_lifecycle_select" ON "promotion"."lifecycle_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."lifecycle_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_lifecycle_insert" ON "promotion"."lifecycle_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."lifecycle_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_lifecycle_update" ON "promotion"."lifecycle_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."lifecycle_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."lifecycle_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_lifecycle_delete" ON "promotion"."lifecycle_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."lifecycle_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_draft_select" ON "promotion"."promotion_drafts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."promotion_drafts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_draft_insert" ON "promotion"."promotion_drafts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."promotion_drafts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_draft_update" ON "promotion"."promotion_drafts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."promotion_drafts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."promotion_drafts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_draft_delete" ON "promotion"."promotion_drafts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."promotion_drafts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_published_select" ON "promotion"."published_promotions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."published_promotions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_published_insert" ON "promotion"."published_promotions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."published_promotions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_published_update" ON "promotion"."published_promotions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."published_promotions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."published_promotions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_published_delete" ON "promotion"."published_promotions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."published_promotions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_selection_policy_select" ON "promotion"."selection_policies" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."selection_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_selection_policy_insert" ON "promotion"."selection_policies" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."selection_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_selection_policy_update" ON "promotion"."selection_policies" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."selection_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."selection_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_selection_policy_delete" ON "promotion"."selection_policies" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."selection_policies"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_generation_select" ON "promotion"."tenant_generations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."tenant_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_generation_insert" ON "promotion"."tenant_generations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."tenant_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_generation_update" ON "promotion"."tenant_generations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."tenant_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."tenant_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_generation_delete" ON "promotion"."tenant_generations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."tenant_generations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_disable_select" ON "promotion"."voucher_disable_facts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."voucher_disable_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_disable_insert" ON "promotion"."voucher_disable_facts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."voucher_disable_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_disable_update" ON "promotion"."voucher_disable_facts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."voucher_disable_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."voucher_disable_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_disable_delete" ON "promotion"."voucher_disable_facts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."voucher_disable_facts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_select" ON "promotion"."vouchers" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("promotion"."vouchers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_insert" ON "promotion"."vouchers" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("promotion"."vouchers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_update" ON "promotion"."vouchers" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("promotion"."vouchers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("promotion"."vouchers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promotion_voucher_delete" ON "promotion"."vouchers" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("promotion"."vouchers"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);