CREATE TABLE "commerce_customer_context"."market_retirement_reservations" (
	"market_retirement_reservation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assessment_digest" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"last_action_invocation_id" uuid,
	"last_operation" text,
	"lifecycle" text DEFAULT 'RESERVED' NOT NULL,
	"market_resource_id" text NOT NULL,
	"market_revision" integer NOT NULL,
	"reservation_version" integer DEFAULT 1 NOT NULL,
	"source_evidence" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ccc_market_retirement_reservations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","market_retirement_reservation_id"),
	CONSTRAINT "ccc_market_retirement_reservations_action_uk" UNIQUE("tenant_id","legal_entity_id","action_invocation_id"),
	CONSTRAINT "ccc_market_retirement_reservations_market_ck" CHECK ("market_resource_id" = btrim("market_resource_id") and length("market_resource_id") > 0),
	CONSTRAINT "ccc_market_retirement_reservations_market_revision_ck" CHECK ("market_revision" > 0),
	CONSTRAINT "ccc_market_retirement_reservations_digest_ck" CHECK ("assessment_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ccc_market_retirement_reservations_evidence_ck" CHECK (jsonb_typeof("source_evidence") = 'array' and jsonb_array_length("source_evidence") > 0),
	CONSTRAINT "ccc_market_retirement_reservations_lifecycle_ck" CHECK ("lifecycle" in ('RESERVED', 'COMMITTED', 'RELEASED')),
	CONSTRAINT "ccc_market_retirement_reservations_last_operation_ck" CHECK (("last_action_invocation_id" is null and "last_operation" is null) or ("last_action_invocation_id" is not null and "last_operation" in ('COMMIT', 'RELEASE'))),
	CONSTRAINT "ccc_market_retirement_reservations_version_ck" CHECK ("reservation_version" > 0),
	CONSTRAINT "ccc_market_retirement_reservations_reason_ck" CHECK ("reason" = btrim("reason") and length("reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_customer_context"."market_retirement_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_market_retirement_reservations_active_market_uk" ON "commerce_customer_context"."market_retirement_reservations" ("tenant_id","legal_entity_id","market_resource_id") WHERE "lifecycle" in ('RESERVED', 'COMMITTED');--> statement-breakpoint
CREATE POLICY "ccc_market_retirement_reservations_scope_select" ON "commerce_customer_context"."market_retirement_reservations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_retirement_reservations_scope_insert" ON "commerce_customer_context"."market_retirement_reservations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_retirement_reservations_scope_update" ON "commerce_customer_context"."market_retirement_reservations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_retirement_reservations_scope_delete" ON "commerce_customer_context"."market_retirement_reservations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ccc_market_retirement_reservations_scope_owner_routine" ON "commerce_customer_context"."market_retirement_reservations" AS PERMISSIVE FOR ALL TO public USING ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("commerce_customer_context"."market_retirement_reservations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "commerce_customer_context"."market_retirement_reservations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
