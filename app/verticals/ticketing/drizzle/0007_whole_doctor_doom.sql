CREATE TABLE "ticketing"."select_options" (
	"color" text NOT NULL,
	"manual_position" integer NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"option_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_select_options_name_ck" CHECK (btrim("ticketing"."select_options"."name") <> ''),
	CONSTRAINT "ticketing_select_options_manual_position_ck" CHECK ("ticketing"."select_options"."manual_position" >= 0),
	CONSTRAINT "ticketing_select_options_revision_ck" CHECK ("ticketing"."select_options"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_select_values" (
	"option_id" uuid,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_select_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_select_values_revision_ck" CHECK ("ticketing"."task_select_values"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD COLUMN "select_option_order_mode" text;--> statement-breakpoint
ALTER TABLE "ticketing"."select_options" ADD CONSTRAINT "select_options_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."select_options" ADD CONSTRAINT "select_options_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_select_options_ownership_uk" ON "ticketing"."select_options" USING btree ("tenant_id","property_definition_id","option_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_select_values" ADD CONSTRAINT "task_select_values_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_select_values" ADD CONSTRAINT "task_select_values_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_select_values" ADD CONSTRAINT "task_select_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_select_values" ADD CONSTRAINT "ticketing_task_select_values_option_fk" FOREIGN KEY ("tenant_id","property_definition_id","option_id") REFERENCES "ticketing"."select_options"("tenant_id","property_definition_id","option_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_select_options_definition_name_uk" ON "ticketing"."select_options" USING btree ("property_definition_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "ticketing_select_options_manual_position_uk" ON "ticketing"."select_options" USING btree ("property_definition_id","manual_position");--> statement-breakpoint
CREATE INDEX "ticketing_task_select_values_filter_idx" ON "ticketing"."task_select_values" USING btree ("tenant_id","property_definition_id","option_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_select_order_ck" CHECK (("ticketing"."task_property_definitions"."datatype" = 'select' and "ticketing"."task_property_definitions"."select_option_order_mode" in ('manual', 'alphabetical', 'reverse_alphabetical')) or ("ticketing"."task_property_definitions"."datatype" <> 'select' and "ticketing"."task_property_definitions"."select_option_order_mode" is null));--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'select'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'checkbox_value_changed', 'select_value_changed', 'archived', 'restored', 'soft_deleted'));
