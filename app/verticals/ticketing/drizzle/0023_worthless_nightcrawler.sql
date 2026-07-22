CREATE TABLE "ticketing"."multi_select_options" (
	"catalog_position" integer NOT NULL,
	"color" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"option_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticketing_multi_select_options_name_ck" CHECK (btrim("ticketing"."multi_select_options"."name") <> ''),
	CONSTRAINT "ticketing_multi_select_options_no_comma_ck" CHECK ("ticketing"."multi_select_options"."name" not like '%,%'),
	CONSTRAINT "ticketing_multi_select_options_catalog_position_ck" CHECK ("ticketing"."multi_select_options"."catalog_position" >= 0),
	CONSTRAINT "ticketing_multi_select_options_revision_ck" CHECK ("ticketing"."multi_select_options"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_multi_select_selections" (
	"option_id" uuid NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_multi_select_selections_pk" PRIMARY KEY("task_id","property_definition_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_multi_select_values" (
	"collection_id" uuid NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"schema_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticketing_task_multi_select_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_multi_select_values_revision_ck" CHECK ("ticketing"."task_multi_select_values"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_property_definitions_tenant_definition_uk" ON "ticketing"."task_property_definitions" USING btree ("tenant_id","property_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_multi_select_options_ownership_uk" ON "ticketing"."multi_select_options" USING btree ("tenant_id","property_definition_id","option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_task_multi_select_values_ownership_uk" ON "ticketing"."task_multi_select_values" USING btree ("tenant_id","task_id","property_definition_id");--> statement-breakpoint
ALTER TABLE "ticketing"."multi_select_options" ADD CONSTRAINT "multi_select_options_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."multi_select_options" ADD CONSTRAINT "ticketing_multi_select_options_definition_fk" FOREIGN KEY ("tenant_id","property_definition_id") REFERENCES "ticketing"."task_property_definitions"("tenant_id","property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_selections" ADD CONSTRAINT "task_multi_select_selections_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_selections" ADD CONSTRAINT "ticketing_task_multi_select_selections_value_fk" FOREIGN KEY ("tenant_id","task_id","property_definition_id") REFERENCES "ticketing"."task_multi_select_values"("tenant_id","task_id","property_definition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_selections" ADD CONSTRAINT "ticketing_task_multi_select_selections_option_fk" FOREIGN KEY ("tenant_id","property_definition_id","option_id") REFERENCES "ticketing"."multi_select_options"("tenant_id","property_definition_id","option_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "task_multi_select_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "ticketing_task_multi_select_values_task_fk" FOREIGN KEY ("tenant_id","collection_id","task_id") REFERENCES "ticketing"."tasks"("tenant_id","collection_id","task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "ticketing_task_multi_select_values_schema_fk" FOREIGN KEY ("tenant_id","collection_id","schema_id") REFERENCES "ticketing"."task_schemas"("tenant_id","collection_id","schema_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_multi_select_values" ADD CONSTRAINT "ticketing_task_multi_select_values_definition_fk" FOREIGN KEY ("tenant_id","schema_id","property_definition_id") REFERENCES "ticketing"."task_property_definitions"("tenant_id","schema_id","property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_multi_select_options_definition_name_uk" ON "ticketing"."multi_select_options" USING btree ("property_definition_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_multi_select_options_catalog_position_uk" ON "ticketing"."multi_select_options" USING btree ("property_definition_id","catalog_position");--> statement-breakpoint
CREATE INDEX "ticketing_task_multi_select_selections_membership_idx" ON "ticketing"."task_multi_select_selections" USING btree ("tenant_id","property_definition_id","option_id");--> statement-breakpoint
CREATE INDEX "ticketing_task_multi_select_values_definition_idx" ON "ticketing"."task_multi_select_values" USING btree ("tenant_id","property_definition_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'created_time', 'created_by', 'last_edited_time', 'date', 'date_range', 'email', 'files_media', 'id', 'multi_select', 'number', 'person', 'phone', 'select', 'status', 'text', 'url'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'content_changed', 'checkbox_value_changed', 'date_value_changed', 'date_range_value_changed', 'email_value_changed', 'files_media_value_changed', 'multi_select_value_changed', 'number_value_changed', 'person_value_changed', 'phone_value_changed', 'select_value_changed', 'status_value_changed', 'text_value_changed', 'url_value_changed', 'archived', 'restored', 'soft_deleted'));
