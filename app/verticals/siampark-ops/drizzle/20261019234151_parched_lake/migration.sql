CREATE SCHEMA "demo_siampark_ops";
--> statement-breakpoint
CREATE TABLE "demo_siampark_ops"."agenda_states" (
	"agenda" text,
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id","agenda"),
	CONSTRAINT "demo_siampark_ops_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "demo_siampark_ops_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "demo_siampark_ops"."agenda_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "demo_siampark_ops"."files" (
	"bytes" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"id" text,
	"legal_entity_id" uuid,
	"mime" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "files_pkey" PRIMARY KEY("tenant_id","legal_entity_id","id"),
	CONSTRAINT "demo_siampark_ops_file_size" CHECK ("size" >= 0 and "size" <= 5242880)
);
--> statement-breakpoint
ALTER TABLE "demo_siampark_ops"."files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "demo_siampark_ops"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "demo_siampark_ops_redemption_expiry" ON "demo_siampark_ops"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_state_scope_select" ON "demo_siampark_ops"."agenda_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("demo_siampark_ops"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_state_scope_insert" ON "demo_siampark_ops"."agenda_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("demo_siampark_ops"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_state_scope_update" ON "demo_siampark_ops"."agenda_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("demo_siampark_ops"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("demo_siampark_ops"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_state_scope_delete" ON "demo_siampark_ops"."agenda_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("demo_siampark_ops"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_file_scope_select" ON "demo_siampark_ops"."files" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("demo_siampark_ops"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_file_scope_insert" ON "demo_siampark_ops"."files" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("demo_siampark_ops"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_file_scope_update" ON "demo_siampark_ops"."files" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("demo_siampark_ops"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("demo_siampark_ops"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "demo_siampark_ops_file_scope_delete" ON "demo_siampark_ops"."files" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("demo_siampark_ops"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "demo_siampark_ops"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "demo_siampark_ops"."agenda_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "demo_siampark_ops"."files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "demo_siampark_ops" TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "demo_siampark_ops"."agenda_states", "demo_siampark_ops"."files", "demo_siampark_ops"."gateway_assertion_redemptions" TO ontos_runtime;
