CREATE SCHEMA "commerce_order";
--> statement-breakpoint
CREATE TABLE "commerce_order"."acceptance_bundles" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"bundle_id" text NOT NULL,
	"buyer_principal_id" uuid NOT NULL,
	"approval_request_id" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "order_bundles_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","bundle_id"),
	CONSTRAINT "order_bundles_binding_uk" UNIQUE("tenant_id","legal_entity_id","bundle_id","bundle_hash"),
	CONSTRAINT "order_bundles_hash_ck" CHECK ("bundle_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "commerce_order"."acceptance_bundles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_order"."commitment_attempts" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"bundle_id" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"buyer_principal_id" uuid NOT NULL,
	"commitment_correlation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"order_id" text,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "order_attempts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","attempt_id"),
	CONSTRAINT "order_attempts_correlation_uk" UNIQUE("tenant_id","legal_entity_id","buyer_principal_id","commitment_correlation_id"),
	CONSTRAINT "order_attempts_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "order_attempts_state_ck" CHECK ("status" in ('READY', 'PRECOMMIT_FAILED', 'CANCELLED', 'COMMITTED')),
	CONSTRAINT "order_attempts_order_ck" CHECK (("status" = 'COMMITTED') = ("order_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "commerce_order"."commitment_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_order"."commitment_history" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"revision" integer NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"proof_resource_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_history_revision_uk" UNIQUE("tenant_id","legal_entity_id","attempt_id","revision"),
	CONSTRAINT "order_history_operation_uk" UNIQUE("tenant_id","legal_entity_id","attempt_id","operation_id"),
	CONSTRAINT "order_history_revision_ck" CHECK ("revision" > 0),
	CONSTRAINT "order_history_kind_ck" CHECK ("kind" in ('PREPARED','PRECOMMIT_FAILED','CANCELLED','COMMITTED','APPROVAL_CONSUMED'))
);
--> statement-breakpoint
ALTER TABLE "commerce_order"."commitment_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_order"."committed_orders" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"approval_request_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "order_orders_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","order_id"),
	CONSTRAINT "order_orders_attempt_uk" UNIQUE("tenant_id","legal_entity_id","attempt_id"),
	CONSTRAINT "order_orders_approval_request_uk" UNIQUE("tenant_id","legal_entity_id","approval_request_id")
);
--> statement-breakpoint
ALTER TABLE "commerce_order"."committed_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "commerce_order"."consumption_obligations" (
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"consumption_intent" text NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "order_consumption_order_uk" UNIQUE("tenant_id","legal_entity_id","order_id"),
	CONSTRAINT "order_consumption_intent_uk" UNIQUE("tenant_id","legal_entity_id","consumption_intent")
);
--> statement-breakpoint
ALTER TABLE "commerce_order"."consumption_obligations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_order"."commitment_attempts" ADD CONSTRAINT "order_attempts_bundle_fk" FOREIGN KEY ("tenant_id","legal_entity_id","bundle_id","bundle_hash") REFERENCES "commerce_order"."acceptance_bundles"("tenant_id","legal_entity_id","bundle_id","bundle_hash") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_order"."commitment_history" ADD CONSTRAINT "order_history_attempt_fk" FOREIGN KEY ("tenant_id","legal_entity_id","attempt_id") REFERENCES "commerce_order"."commitment_attempts"("tenant_id","legal_entity_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_order"."committed_orders" ADD CONSTRAINT "order_orders_attempt_fk" FOREIGN KEY ("tenant_id","legal_entity_id","attempt_id") REFERENCES "commerce_order"."commitment_attempts"("tenant_id","legal_entity_id","attempt_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "commerce_order"."consumption_obligations" ADD CONSTRAINT "order_consumption_order_fk" FOREIGN KEY ("tenant_id","legal_entity_id","order_id") REFERENCES "commerce_order"."committed_orders"("tenant_id","legal_entity_id","order_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "order_bundles_select" ON "commerce_order"."acceptance_bundles" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_order"."acceptance_bundles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."acceptance_bundles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_bundles_insert" ON "commerce_order"."acceptance_bundles" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_order"."acceptance_bundles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."acceptance_bundles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_bundles_update" ON "commerce_order"."acceptance_bundles" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_order"."acceptance_bundles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."acceptance_bundles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_order"."acceptance_bundles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."acceptance_bundles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_bundles_delete" ON "commerce_order"."acceptance_bundles" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_order"."acceptance_bundles"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."acceptance_bundles"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_attempts_select" ON "commerce_order"."commitment_attempts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_order"."commitment_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_attempts_insert" ON "commerce_order"."commitment_attempts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_order"."commitment_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_attempts_update" ON "commerce_order"."commitment_attempts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_order"."commitment_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_order"."commitment_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_attempts_delete" ON "commerce_order"."commitment_attempts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_order"."commitment_attempts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_attempts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_history_select" ON "commerce_order"."commitment_history" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_order"."commitment_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_history_insert" ON "commerce_order"."commitment_history" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_order"."commitment_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_history_update" ON "commerce_order"."commitment_history" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_order"."commitment_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_order"."commitment_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_history_delete" ON "commerce_order"."commitment_history" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_order"."commitment_history"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."commitment_history"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_orders_select" ON "commerce_order"."committed_orders" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_order"."committed_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."committed_orders"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_orders_insert" ON "commerce_order"."committed_orders" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_order"."committed_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."committed_orders"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_orders_update" ON "commerce_order"."committed_orders" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_order"."committed_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."committed_orders"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_order"."committed_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."committed_orders"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_orders_delete" ON "commerce_order"."committed_orders" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_order"."committed_orders"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."committed_orders"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_consumption_select" ON "commerce_order"."consumption_obligations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_order"."consumption_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."consumption_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_consumption_insert" ON "commerce_order"."consumption_obligations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_order"."consumption_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."consumption_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_consumption_update" ON "commerce_order"."consumption_obligations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_order"."consumption_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."consumption_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_order"."consumption_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."consumption_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "order_consumption_delete" ON "commerce_order"."consumption_obligations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_order"."consumption_obligations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_order"."consumption_obligations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);