CREATE TABLE "communications"."intent_document_pins" (
	"asset_id" text NOT NULL,
	"asset_module" text NOT NULL,
	"asset_type" text NOT NULL,
	"classification" text NOT NULL,
	"document_id" text NOT NULL,
	"document_module" text NOT NULL,
	"document_type" text NOT NULL,
	"form" text NOT NULL,
	"intent_id" uuid,
	"pinned_at" timestamp with time zone NOT NULL,
	"position" integer,
	"revision" integer NOT NULL,
	"tenant_id" uuid,
	CONSTRAINT "communications_document_pins_pk" PRIMARY KEY("tenant_id","intent_id","position"),
	CONSTRAINT "communications_document_pins_position_ck" CHECK ("position" between 0 and 9),
	CONSTRAINT "communications_document_pins_form_ck" CHECK ("form" in ('ATTACHMENT', 'LINK')),
	CONSTRAINT "communications_document_pins_asset_ck" CHECK ("asset_module" = 'core.media' and "asset_type" = 'core.media.asset' and "revision" = 1)
);
--> statement-breakpoint
ALTER TABLE "communications"."intent_document_pins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "communications"."intent_document_pins" ADD CONSTRAINT "communications_document_pins_intent_fk" FOREIGN KEY ("tenant_id","intent_id") REFERENCES "communications"."message_intents"("tenant_id","intent_id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "intent_document_pins_select" ON "communications"."intent_document_pins" AS PERMISSIVE FOR SELECT TO "ontos_runtime" USING ("communications"."intent_document_pins"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_document_pins_insert" ON "communications"."intent_document_pins" AS PERMISSIVE FOR INSERT TO "ontos_runtime" WITH CHECK ("communications"."intent_document_pins"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_document_pins_update" ON "communications"."intent_document_pins" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING ("communications"."intent_document_pins"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid) WITH CHECK ("communications"."intent_document_pins"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "intent_document_pins_delete" ON "communications"."intent_document_pins" AS PERMISSIVE FOR DELETE TO "ontos_runtime" USING ("communications"."intent_document_pins"."tenant_id" = nullif(current_setting('ontos.tenant_id', true), '')::uuid);