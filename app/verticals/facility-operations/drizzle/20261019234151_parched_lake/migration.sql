CREATE SCHEMA "facility_operations";
--> statement-breakpoint
CREATE TABLE "facility_operations"."agenda_states" (
	"agenda" text,
	"legal_entity_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" jsonb NOT NULL,
	"tenant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_states_pkey" PRIMARY KEY("tenant_id","legal_entity_id","agenda"),
	CONSTRAINT "facility_operations_revision_nonnegative" CHECK ("revision" >= 0),
	CONSTRAINT "facility_operations_state_object" CHECK (jsonb_typeof("state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "facility_operations"."agenda_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "facility_operations"."files" (
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
	CONSTRAINT "facility_operations_file_size" CHECK ("size" >= 0 and "size" <= 5242880)
);
--> statement-breakpoint
ALTER TABLE "facility_operations"."files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "facility_operations"."gateway_assertion_redemptions" (
	"audience" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issuer" text,
	"jti" text,
	CONSTRAINT "gateway_assertion_redemptions_pkey" PRIMARY KEY("issuer","audience","jti")
);
--> statement-breakpoint
CREATE INDEX "facility_operations_redemption_expiry" ON "facility_operations"."gateway_assertion_redemptions" ("expires_at");--> statement-breakpoint
CREATE POLICY "facility_operations_state_scope_select" ON "facility_operations"."agenda_states" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("facility_operations"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_state_scope_insert" ON "facility_operations"."agenda_states" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("facility_operations"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_state_scope_update" ON "facility_operations"."agenda_states" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("facility_operations"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("facility_operations"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_state_scope_delete" ON "facility_operations"."agenda_states" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("facility_operations"."agenda_states"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."agenda_states"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_file_scope_select" ON "facility_operations"."files" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("facility_operations"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_file_scope_insert" ON "facility_operations"."files" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("facility_operations"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_file_scope_update" ON "facility_operations"."files" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("facility_operations"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("facility_operations"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "facility_operations_file_scope_delete" ON "facility_operations"."files" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("facility_operations"."files"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "facility_operations"."files"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "facility_operations"."agenda_states" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "facility_operations"."files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "facility_operations" TO ontos_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "facility_operations"."agenda_states", "facility_operations"."files", "facility_operations"."gateway_assertion_redemptions" TO ontos_runtime;
