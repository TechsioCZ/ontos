CREATE TABLE "commerce_market_catalog"."market_retirement_admissions" (
	"source_action_invocation_id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"selling_legal_entity_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"composition_revision" text NOT NULL,
	"retirement_payload" jsonb NOT NULL,
	"release_guard_hash" text NOT NULL,
	"abort_proof" uuid NOT NULL,
	"original_reserve_basis" jsonb NOT NULL,
	"status" text NOT NULL,
	"committed_result" jsonb,
	"retirement_assessment" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_retirement_admissions_tenant_source_uk" UNIQUE("tenant_id","source_action_invocation_id"),
	CONSTRAINT "market_retirement_admissions_status_ck" CHECK ("status" in ('PENDING', 'COMMITTED', 'ABORTED')),
	CONSTRAINT "market_retirement_admissions_guard_ck" CHECK ("release_guard_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "market_retirement_admissions_revision_ck" CHECK ("composition_revision" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "market_retirement_admissions_receipt_ck" CHECK (("status" = 'COMMITTED' and "committed_result" is not null and "retirement_assessment" is not null) or ("status" in ('PENDING','ABORTED') and "committed_result" is null and "retirement_assessment" is null))
);
--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_retirement_admissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_retirement_admissions" ADD CONSTRAINT "market_retirement_admissions_market_fk" FOREIGN KEY ("tenant_id","market_id") REFERENCES "commerce_market_catalog"."markets"("tenant_id","market_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "market_retirement_admissions_tenant_select" ON "commerce_market_catalog"."market_retirement_admissions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_market_catalog"."market_retirement_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "market_retirement_admissions_tenant_insert" ON "commerce_market_catalog"."market_retirement_admissions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_market_catalog"."market_retirement_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "market_retirement_admissions_tenant_update" ON "commerce_market_catalog"."market_retirement_admissions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_market_catalog"."market_retirement_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("commerce_market_catalog"."market_retirement_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "market_retirement_admissions_tenant_delete" ON "commerce_market_catalog"."market_retirement_admissions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_market_catalog"."market_retirement_admissions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "commerce_market_catalog"."market_retirement_admissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "commerce_market_catalog"."market_retirement_admissions" FROM PUBLIC, ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "commerce_market_catalog"."market_retirement_admissions" TO ontos_runtime;
