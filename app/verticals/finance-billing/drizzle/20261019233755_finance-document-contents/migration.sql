CREATE TABLE "finance_billing"."finance_document_contents" (
	"content_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" text,
	"legal_entity_id" uuid,
	"mime_type" text NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "finance_document_contents_pkey" PRIMARY KEY("tenant_id","legal_entity_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "finance_billing"."finance_document_contents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "finance_billing_document_scope_select" ON "finance_billing"."finance_document_contents" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("finance_billing"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_billing_document_scope_insert" ON "finance_billing"."finance_document_contents" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("finance_billing"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_billing_document_scope_update" ON "finance_billing"."finance_document_contents" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("finance_billing"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid) WITH CHECK ("finance_billing"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_billing_document_scope_delete" ON "finance_billing"."finance_document_contents" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("finance_billing"."finance_document_contents"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid and "finance_billing"."finance_document_contents"."legal_entity_id" = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "finance_billing"."finance_document_contents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_billing"."finance_document_contents" TO "ontos_runtime";
