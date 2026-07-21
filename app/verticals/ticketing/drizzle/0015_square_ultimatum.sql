CREATE TABLE "ticketing"."task_files_media_items" (
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_files_media_items_position_ck" CHECK ("ticketing"."task_files_media_items"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_files_media_items" ADD CONSTRAINT "task_files_media_items_media_asset_id_media_assets_media_asset_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "core"."media_assets"("media_asset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_files_media_items" ADD CONSTRAINT "task_files_media_items_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_files_media_items" ADD CONSTRAINT "task_files_media_items_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_files_media_items" ADD CONSTRAINT "task_files_media_items_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_files_media_items_position_uk" ON "ticketing"."task_files_media_items" USING btree ("task_id","property_definition_id","position");--> statement-breakpoint
CREATE INDEX "ticketing_task_files_media_items_value_idx" ON "ticketing"."task_files_media_items" USING btree ("tenant_id","task_id","property_definition_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'created_time', 'created_by', 'email', 'files_media', 'number', 'phone', 'select', 'text', 'url'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'checkbox_value_changed', 'email_value_changed', 'files_media_value_changed', 'number_value_changed', 'phone_value_changed', 'select_value_changed', 'text_value_changed', 'url_value_changed', 'archived', 'restored', 'soft_deleted'));