CREATE TABLE "payment"."psp_binding_routes" (
	"legal_entity_id" uuid NOT NULL,
	"tenant_id" uuid,
	"binding_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"environment" text NOT NULL,
	"provider_family" text NOT NULL,
	"route_key" text,
	"route_revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_psp_binding_routes_pk" PRIMARY KEY("tenant_id","route_key"),
	CONSTRAINT "payment_psp_binding_routes_binding_uk" UNIQUE("tenant_id","legal_entity_id","binding_id"),
	CONSTRAINT "payment_psp_binding_routes_key_ck" CHECK ("route_key" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_psp_binding_routes_revision_ck" CHECK ("route_revision" > 0),
	CONSTRAINT "payment_psp_binding_routes_family_ck" CHECK ("provider_family" in ('GOPAY', 'STRIPE', 'COMGATE')),
	CONSTRAINT "payment_psp_binding_routes_environment_ck" CHECK ("environment" in ('SANDBOX', 'LIVE'))
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_binding_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment"."psp_operation_payer_contacts" (
	"legal_entity_id" uuid,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text,
	"full_name" text,
	"operation_id" uuid,
	"phone" text,
	CONSTRAINT "payment_psp_payer_contacts_pk" PRIMARY KEY("tenant_id","legal_entity_id","operation_id"),
	CONSTRAINT "payment_psp_payer_contacts_present_ck" CHECK (num_nonnulls("email", "full_name", "phone") > 0),
	CONSTRAINT "payment_psp_payer_contacts_email_ck" CHECK ("email" is null or ("email" = btrim("email") and length("email") between 1 and 254)),
	CONSTRAINT "payment_psp_payer_contacts_full_name_ck" CHECK ("full_name" is null or ("full_name" = btrim("full_name") and length("full_name") between 1 and 200)),
	CONSTRAINT "payment_psp_payer_contacts_phone_ck" CHECK ("phone" is null or ("phone" = btrim("phone") and length("phone") between 1 and 40))
);
--> statement-breakpoint
ALTER TABLE "payment"."psp_operation_payer_contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "payment_recovery_requests_operation_idx" ON "payment"."recovery_requests" ("tenant_id","legal_entity_id","operation_id","requested_at");--> statement-breakpoint
ALTER TABLE "payment"."psp_binding_routes" ADD CONSTRAINT "payment_psp_binding_routes_binding_fk" FOREIGN KEY ("tenant_id","legal_entity_id","binding_id","provider_family","environment") REFERENCES "payment"."psp_provider_account_bindings"("tenant_id","legal_entity_id","binding_id","provider_family","environment") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "payment"."psp_operation_payer_contacts" ADD CONSTRAINT "payment_psp_payer_contacts_operation_fk" FOREIGN KEY ("tenant_id","legal_entity_id","operation_id") REFERENCES "payment"."payment_operations"("tenant_id","legal_entity_id","operation_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "payment_psp_binding_routes_select" ON "payment"."psp_binding_routes" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_binding_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_binding_routes_insert" ON "payment"."psp_binding_routes" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_binding_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_binding_routes_update" ON "payment"."psp_binding_routes" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_binding_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("payment"."psp_binding_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_binding_routes_delete" ON "payment"."psp_binding_routes" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_binding_routes"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_operation_payer_contacts_select" ON "payment"."psp_operation_payer_contacts" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("payment"."psp_operation_payer_contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_operation_payer_contacts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_operation_payer_contacts_insert" ON "payment"."psp_operation_payer_contacts" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("payment"."psp_operation_payer_contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_operation_payer_contacts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_operation_payer_contacts_update" ON "payment"."psp_operation_payer_contacts" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("payment"."psp_operation_payer_contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_operation_payer_contacts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("payment"."psp_operation_payer_contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_operation_payer_contacts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_psp_operation_payer_contacts_delete" ON "payment"."psp_operation_payer_contacts" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("payment"."psp_operation_payer_contacts"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "payment"."psp_operation_payer_contacts"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);