CREATE SCHEMA "legal_agreements";
--> statement-breakpoint
CREATE TABLE "legal_agreements"."state" (
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "state_pkey" PRIMARY KEY("tenant_id","legal_entity_id"),
	CONSTRAINT "agreements_state_revision_ck" CHECK ("revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "legal_agreements"."state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "legal_agreements"."gateway_assertion_redemptions" (
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"jti" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_agreements_assertion_identity_uk" UNIQUE("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "legal_agreements_assertion_expiry_idx" ON "legal_agreements"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "agreements_state_scope_select" ON "legal_agreements"."state" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("legal_agreements"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "legal_agreements"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agreements_state_scope_insert" ON "legal_agreements"."state" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("legal_agreements"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "legal_agreements"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agreements_state_scope_update" ON "legal_agreements"."state" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("legal_agreements"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "legal_agreements"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("legal_agreements"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "legal_agreements"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "agreements_state_scope_delete" ON "legal_agreements"."state" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("legal_agreements"."state"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "legal_agreements"."state"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "legal_agreements"."state" FORCE ROW LEVEL SECURITY;
