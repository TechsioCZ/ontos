CREATE TABLE "pricing"."contractual_discount_action_invocation_receipts" (
	"contractual_discount_action_invocation_receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"command_fingerprint" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_contractual_discount_action_receipts_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_contractual_discount_action_receipts_fingerprint_ck" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_contractual_discount_action_receipts_outcome_ck" CHECK (jsonb_typeof("outcome") = 'object')
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_action_invocation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."contractual_discount_revisions" (
	"contractual_discount_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"previous_contractual_discount_revision_id" uuid,
	"schedule" jsonb NOT NULL,
	"action_invocation_id" uuid NOT NULL,
	"command_fingerprint" text NOT NULL,
	"acting_principal_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_contractual_discount_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","discount_id","contractual_discount_revision_id"),
	CONSTRAINT "pricing_contractual_discount_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","discount_id","schedule_revision"),
	CONSTRAINT "pricing_contractual_discount_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_contractual_discount_revisions_number_ck" CHECK ("schedule_revision" > 0),
	CONSTRAINT "pricing_contractual_discount_revisions_schedule_ck" CHECK (jsonb_typeof("schedule") = 'object'),
	CONSTRAINT "pricing_contractual_discount_revisions_fingerprint_ck" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."contractual_discount_schedule_heads" (
	"contractual_discount_schedule_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"contractual_discount_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	CONSTRAINT "pricing_contractual_discount_schedule_heads_discount_uk" UNIQUE("tenant_id","legal_entity_id","discount_id"),
	CONSTRAINT "pricing_contractual_discount_schedule_heads_revision_ck" CHECK ("schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_schedule_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."contractual_discount_set_heads" (
	"contractual_discount_set_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"contractual_discount_set_root_id" uuid NOT NULL,
	"contractual_discount_set_revision_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	CONSTRAINT "pricing_contractual_discount_set_heads_scope_uk" UNIQUE("tenant_id","legal_entity_id"),
	CONSTRAINT "pricing_contractual_discount_set_heads_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_set_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."contractual_discount_set_revisions" (
	"contractual_discount_set_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"contractual_discount_set_root_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"previous_contractual_discount_set_revision_id" uuid,
	"action_invocation_id" uuid NOT NULL,
	"mutation_kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_contractual_discount_set_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","contractual_discount_set_root_id","contractual_discount_set_revision_id"),
	CONSTRAINT "pricing_contractual_discount_set_revisions_generation_uk" UNIQUE("tenant_id","legal_entity_id","contractual_discount_set_root_id","generation"),
	CONSTRAINT "pricing_contractual_discount_set_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_contractual_discount_set_revisions_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_set_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."contractual_discount_set_roots" (
	"contractual_discount_set_root_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_contractual_discount_set_roots_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","contractual_discount_set_root_id"),
	CONSTRAINT "pricing_contractual_discount_set_roots_scope_uk" UNIQUE("tenant_id","legal_entity_id")
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_set_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."contractual_discounts" (
	"discount_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"identity_ref" text NOT NULL,
	"identity_key" jsonb NOT NULL,
	"created_by_action_invocation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_contractual_discounts_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","discount_id"),
	CONSTRAINT "pricing_contractual_discounts_identity_uk" UNIQUE("tenant_id","legal_entity_id","identity_ref"),
	CONSTRAINT "pricing_contractual_discounts_invocation_uk" UNIQUE("tenant_id","created_by_action_invocation_id"),
	CONSTRAINT "pricing_contractual_discounts_identity_ref_ck" CHECK (length("identity_ref") = 64),
	CONSTRAINT "pricing_contractual_discounts_identity_payload_ck" CHECK (jsonb_typeof("identity_key") = 'object')
);
--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_action_invocation_receipts" (
	"zero_floor_action_invocation_receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"action_invocation_id" text NOT NULL,
	"command_fingerprint" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_zero_floor_action_receipts_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_zero_floor_action_receipts_fingerprint_ck" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pricing_zero_floor_action_receipts_outcome_ck" CHECK (jsonb_typeof("outcome") = 'object')
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_action_invocation_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_authorization_revisions" (
	"zero_floor_authorization_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"zero_floor_authorization_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	"previous_zero_floor_authorization_revision_id" uuid,
	"schedule" jsonb NOT NULL,
	"action_invocation_id" text NOT NULL,
	"command_fingerprint" text NOT NULL,
	"acting_principal_id" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_zero_floor_authorization_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_authorization_id","zero_floor_authorization_revision_id"),
	CONSTRAINT "pricing_zero_floor_authorization_revisions_number_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_authorization_id","schedule_revision"),
	CONSTRAINT "pricing_zero_floor_authorization_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_zero_floor_authorization_revisions_number_ck" CHECK ("schedule_revision" > 0),
	CONSTRAINT "pricing_zero_floor_authorization_revisions_schedule_ck" CHECK (jsonb_typeof("schedule") = 'object'),
	CONSTRAINT "pricing_zero_floor_authorization_revisions_fingerprint_ck" CHECK ("command_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_authorization_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_authorization_schedule_heads" (
	"zero_floor_authorization_schedule_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"zero_floor_authorization_id" uuid NOT NULL,
	"zero_floor_authorization_revision_id" uuid NOT NULL,
	"schedule_revision" integer NOT NULL,
	CONSTRAINT "pricing_zero_floor_authorization_schedule_heads_authorization_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_authorization_id"),
	CONSTRAINT "pricing_zero_floor_authorization_schedule_heads_revision_ck" CHECK ("schedule_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_authorization_schedule_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_authorizations" (
	"zero_floor_authorization_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"authorization_ref" text NOT NULL,
	"created_by_action_invocation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_zero_floor_authorizations_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_authorization_id"),
	CONSTRAINT "pricing_zero_floor_authorizations_ref_uk" UNIQUE("tenant_id","legal_entity_id","authorization_ref")
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_set_heads" (
	"zero_floor_set_head_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"zero_floor_set_root_id" uuid NOT NULL,
	"zero_floor_set_revision_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	CONSTRAINT "pricing_zero_floor_set_heads_scope_uk" UNIQUE("tenant_id","legal_entity_id"),
	CONSTRAINT "pricing_zero_floor_set_heads_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_set_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_set_revisions" (
	"zero_floor_set_revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"zero_floor_set_root_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"previous_zero_floor_set_revision_id" uuid,
	"action_invocation_id" text NOT NULL,
	"mutation_kind" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_zero_floor_set_revisions_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_set_root_id","zero_floor_set_revision_id"),
	CONSTRAINT "pricing_zero_floor_set_revisions_generation_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_set_root_id","generation"),
	CONSTRAINT "pricing_zero_floor_set_revisions_invocation_uk" UNIQUE("tenant_id","action_invocation_id"),
	CONSTRAINT "pricing_zero_floor_set_revisions_generation_ck" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_set_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pricing"."zero_floor_set_roots" (
	"zero_floor_set_root_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"created_by_action_invocation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_zero_floor_set_roots_scope_id_uk" UNIQUE("tenant_id","legal_entity_id","zero_floor_set_root_id"),
	CONSTRAINT "pricing_zero_floor_set_roots_scope_uk" UNIQUE("tenant_id","legal_entity_id")
);
--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_set_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_revisions" ADD CONSTRAINT "pricing_contractual_discount_revisions_discount_fk" FOREIGN KEY ("tenant_id","legal_entity_id","discount_id") REFERENCES "pricing"."contractual_discounts"("tenant_id","legal_entity_id","discount_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_revisions" ADD CONSTRAINT "pricing_contractual_discount_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","discount_id","previous_contractual_discount_revision_id") REFERENCES "pricing"."contractual_discount_revisions"("tenant_id","legal_entity_id","discount_id","contractual_discount_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_schedule_heads" ADD CONSTRAINT "pricing_contractual_discount_schedule_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","discount_id","contractual_discount_revision_id") REFERENCES "pricing"."contractual_discount_revisions"("tenant_id","legal_entity_id","discount_id","contractual_discount_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_set_heads" ADD CONSTRAINT "pricing_contractual_discount_set_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","contractual_discount_set_root_id","contractual_discount_set_revision_id") REFERENCES "pricing"."contractual_discount_set_revisions"("tenant_id","legal_entity_id","contractual_discount_set_root_id","contractual_discount_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_set_revisions" ADD CONSTRAINT "pricing_contractual_discount_set_revisions_root_fk" FOREIGN KEY ("tenant_id","legal_entity_id","contractual_discount_set_root_id") REFERENCES "pricing"."contractual_discount_set_roots"("tenant_id","legal_entity_id","contractual_discount_set_root_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."contractual_discount_set_revisions" ADD CONSTRAINT "pricing_contractual_discount_set_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","contractual_discount_set_root_id","previous_contractual_discount_set_revision_id") REFERENCES "pricing"."contractual_discount_set_revisions"("tenant_id","legal_entity_id","contractual_discount_set_root_id","contractual_discount_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_authorization_revisions" ADD CONSTRAINT "pricing_zero_floor_authorization_revisions_authorization_fk" FOREIGN KEY ("tenant_id","legal_entity_id","zero_floor_authorization_id") REFERENCES "pricing"."zero_floor_authorizations"("tenant_id","legal_entity_id","zero_floor_authorization_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_authorization_revisions" ADD CONSTRAINT "pricing_zero_floor_authorization_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","zero_floor_authorization_id","previous_zero_floor_authorization_revision_id") REFERENCES "pricing"."zero_floor_authorization_revisions"("tenant_id","legal_entity_id","zero_floor_authorization_id","zero_floor_authorization_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_authorization_schedule_heads" ADD CONSTRAINT "pricing_zero_floor_authorization_schedule_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","zero_floor_authorization_id","zero_floor_authorization_revision_id") REFERENCES "pricing"."zero_floor_authorization_revisions"("tenant_id","legal_entity_id","zero_floor_authorization_id","zero_floor_authorization_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_set_heads" ADD CONSTRAINT "pricing_zero_floor_set_heads_revision_fk" FOREIGN KEY ("tenant_id","legal_entity_id","zero_floor_set_root_id","zero_floor_set_revision_id") REFERENCES "pricing"."zero_floor_set_revisions"("tenant_id","legal_entity_id","zero_floor_set_root_id","zero_floor_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_set_revisions" ADD CONSTRAINT "pricing_zero_floor_set_revisions_root_fk" FOREIGN KEY ("tenant_id","legal_entity_id","zero_floor_set_root_id") REFERENCES "pricing"."zero_floor_set_roots"("tenant_id","legal_entity_id","zero_floor_set_root_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pricing"."zero_floor_set_revisions" ADD CONSTRAINT "pricing_zero_floor_set_revisions_previous_fk" FOREIGN KEY ("tenant_id","legal_entity_id","zero_floor_set_root_id","previous_zero_floor_set_revision_id") REFERENCES "pricing"."zero_floor_set_revisions"("tenant_id","legal_entity_id","zero_floor_set_root_id","zero_floor_set_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_action_receipts_scope_select" ON "pricing"."contractual_discount_action_invocation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_action_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_action_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_action_receipts_scope_insert" ON "pricing"."contractual_discount_action_invocation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_action_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_action_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_action_receipts_scope_update" ON "pricing"."contractual_discount_action_invocation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_action_receipts_scope_delete" ON "pricing"."contractual_discount_action_invocation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_revisions_scope_select" ON "pricing"."contractual_discount_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_revisions_scope_insert" ON "pricing"."contractual_discount_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_revisions_scope_update" ON "pricing"."contractual_discount_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_revisions_scope_delete" ON "pricing"."contractual_discount_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_heads_scope_select" ON "pricing"."contractual_discount_schedule_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_heads_scope_insert" ON "pricing"."contractual_discount_schedule_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_heads_scope_update" ON "pricing"."contractual_discount_schedule_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."contractual_discount_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."contractual_discount_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_schedule_heads_scope_delete" ON "pricing"."contractual_discount_schedule_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."contractual_discount_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_heads_scope_select" ON "pricing"."contractual_discount_set_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_heads_scope_insert" ON "pricing"."contractual_discount_set_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_heads_scope_update" ON "pricing"."contractual_discount_set_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."contractual_discount_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."contractual_discount_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_heads_scope_delete" ON "pricing"."contractual_discount_set_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."contractual_discount_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_revisions_scope_select" ON "pricing"."contractual_discount_set_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_revisions_scope_insert" ON "pricing"."contractual_discount_set_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_revisions_scope_update" ON "pricing"."contractual_discount_set_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_revisions_scope_delete" ON "pricing"."contractual_discount_set_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_roots_scope_select" ON "pricing"."contractual_discount_set_roots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discount_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_roots_scope_insert" ON "pricing"."contractual_discount_set_roots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discount_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discount_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_roots_scope_update" ON "pricing"."contractual_discount_set_roots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discount_set_roots_scope_delete" ON "pricing"."contractual_discount_set_roots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discounts_scope_select" ON "pricing"."contractual_discounts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."contractual_discounts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discounts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discounts_scope_insert" ON "pricing"."contractual_discounts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."contractual_discounts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."contractual_discounts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discounts_scope_update" ON "pricing"."contractual_discounts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_contractual_discounts_scope_delete" ON "pricing"."contractual_discounts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_action_receipts_scope_select" ON "pricing"."zero_floor_action_invocation_receipts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_action_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_action_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_action_receipts_scope_insert" ON "pricing"."zero_floor_action_invocation_receipts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_action_invocation_receipts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_action_invocation_receipts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_action_receipts_scope_update" ON "pricing"."zero_floor_action_invocation_receipts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_action_receipts_scope_delete" ON "pricing"."zero_floor_action_invocation_receipts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_revisions_scope_select" ON "pricing"."zero_floor_authorization_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_authorization_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_revisions_scope_insert" ON "pricing"."zero_floor_authorization_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_authorization_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_revisions_scope_update" ON "pricing"."zero_floor_authorization_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_revisions_scope_delete" ON "pricing"."zero_floor_authorization_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_schedule_heads_scope_select" ON "pricing"."zero_floor_authorization_schedule_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_authorization_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_schedule_heads_scope_insert" ON "pricing"."zero_floor_authorization_schedule_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_authorization_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_schedule_heads_scope_update" ON "pricing"."zero_floor_authorization_schedule_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."zero_floor_authorization_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."zero_floor_authorization_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorization_schedule_heads_scope_delete" ON "pricing"."zero_floor_authorization_schedule_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."zero_floor_authorization_schedule_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorization_schedule_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorizations_scope_select" ON "pricing"."zero_floor_authorizations" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorizations_scope_insert" ON "pricing"."zero_floor_authorizations" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_authorizations"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_authorizations"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorizations_scope_update" ON "pricing"."zero_floor_authorizations" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_authorizations_scope_delete" ON "pricing"."zero_floor_authorizations" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_heads_scope_select" ON "pricing"."zero_floor_set_heads" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_heads_scope_insert" ON "pricing"."zero_floor_set_heads" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_heads_scope_update" ON "pricing"."zero_floor_set_heads" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("pricing"."zero_floor_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("pricing"."zero_floor_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_heads_scope_delete" ON "pricing"."zero_floor_set_heads" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("pricing"."zero_floor_set_heads"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_heads"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_revisions_scope_select" ON "pricing"."zero_floor_set_revisions" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_revisions_scope_insert" ON "pricing"."zero_floor_set_revisions" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_set_revisions"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_revisions"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_revisions_scope_update" ON "pricing"."zero_floor_set_revisions" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_revisions_scope_delete" ON "pricing"."zero_floor_set_revisions" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_roots_scope_select" ON "pricing"."zero_floor_set_roots" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("pricing"."zero_floor_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_roots_scope_insert" ON "pricing"."zero_floor_set_roots" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("pricing"."zero_floor_set_roots"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "pricing"."zero_floor_set_roots"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_roots_scope_update" ON "pricing"."zero_floor_set_roots" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "pricing_zero_floor_set_roots_scope_delete" ON "pricing"."zero_floor_set_roots" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING (false);
