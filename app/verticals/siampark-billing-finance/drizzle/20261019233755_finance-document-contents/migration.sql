CREATE TABLE "siampark_billing_finance"."finance_document_contents" (
	"content_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" text,
	"legal_entity_id" uuid,
	"mime_type" text NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "finance_document_contents_pkey" PRIMARY KEY("tenant_id","legal_entity_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "siampark_billing_finance"."finance_document_contents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "siampark_finance_document_scope_select" ON "siampark_billing_finance"."finance_document_contents" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("siampark_billing_finance"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_finance_document_scope_insert" ON "siampark_billing_finance"."finance_document_contents" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("siampark_billing_finance"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_finance_document_scope_update" ON "siampark_billing_finance"."finance_document_contents" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("siampark_billing_finance"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("siampark_billing_finance"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "siampark_finance_document_scope_delete" ON "siampark_billing_finance"."finance_document_contents" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("siampark_billing_finance"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "siampark_billing_finance"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "siampark_billing_finance"."finance_document_contents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "siampark_billing_finance"."finance_document_contents" TO "ontos_runtime";
