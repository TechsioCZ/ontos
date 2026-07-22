CREATE TABLE "ticketing"."status_options" (
	"color" text NOT NULL,
	"group_key" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"option_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_status_options_group_ck" CHECK ("ticketing"."status_options"."group_key" in ('todo', 'in_progress', 'complete')),
	CONSTRAINT "ticketing_status_options_name_ck" CHECK (btrim("ticketing"."status_options"."name") <> ''),
	CONSTRAINT "ticketing_status_options_position_ck" CHECK ("ticketing"."status_options"."position" >= 0),
	CONSTRAINT "ticketing_status_options_revision_ck" CHECK ("ticketing"."status_options"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ticketing"."status_property_configurations" (
	"default_option_id" uuid NOT NULL,
	"property_definition_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_status_values" (
	"collection_id" uuid NOT NULL,
	"option_id" uuid,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"schema_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_status_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_status_values_revision_ck" CHECK ("ticketing"."task_status_values"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_status_options_definition_name_uk" ON "ticketing"."status_options" USING btree ("property_definition_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_status_options_ownership_uk" ON "ticketing"."status_options" USING btree ("tenant_id","property_definition_id","option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_status_options_group_position_uk" ON "ticketing"."status_options" USING btree ("property_definition_id","group_key","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_property_definitions_ownership_uk" ON "ticketing"."task_property_definitions" USING btree ("tenant_id","schema_id","property_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_schemas_tenant_collection_schema_uk" ON "ticketing"."task_schemas" USING btree ("tenant_id","collection_id","schema_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_tasks_ownership_uk" ON "ticketing"."tasks" USING btree ("tenant_id","collection_id","task_id");--> statement-breakpoint
ALTER TABLE "ticketing"."status_options" ADD CONSTRAINT "status_options_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."status_options" ADD CONSTRAINT "status_options_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."status_property_configurations" ADD CONSTRAINT "status_property_configurations_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."status_property_configurations" ADD CONSTRAINT "status_property_configurations_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."status_property_configurations" ADD CONSTRAINT "ticketing_status_property_configurations_default_option_fk" FOREIGN KEY ("tenant_id","property_definition_id","default_option_id") REFERENCES "ticketing"."status_options"("tenant_id","property_definition_id","option_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "task_status_values_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "task_status_values_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "task_status_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "ticketing_task_status_values_task_ownership_fk" FOREIGN KEY ("tenant_id","collection_id","task_id") REFERENCES "ticketing"."tasks"("tenant_id","collection_id","task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "ticketing_task_status_values_definition_ownership_fk" FOREIGN KEY ("tenant_id","schema_id","property_definition_id") REFERENCES "ticketing"."task_property_definitions"("tenant_id","schema_id","property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "ticketing_task_status_values_schema_ownership_fk" FOREIGN KEY ("tenant_id","collection_id","schema_id") REFERENCES "ticketing"."task_schemas"("tenant_id","collection_id","schema_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_status_values" ADD CONSTRAINT "ticketing_task_status_values_option_fk" FOREIGN KEY ("tenant_id","property_definition_id","option_id") REFERENCES "ticketing"."status_options"("tenant_id","property_definition_id","option_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticketing_task_status_values_option_idx" ON "ticketing"."task_status_values" USING btree ("tenant_id","property_definition_id","option_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'created_time', 'created_by', 'last_edited_time', 'date', 'email', 'files_media', 'id', 'number', 'person', 'phone', 'select', 'status', 'text', 'url'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'content_changed', 'checkbox_value_changed', 'date_value_changed', 'email_value_changed', 'files_media_value_changed', 'number_value_changed', 'person_value_changed', 'phone_value_changed', 'select_value_changed', 'status_value_changed', 'text_value_changed', 'url_value_changed', 'archived', 'restored', 'soft_deleted'));
