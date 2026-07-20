CREATE TABLE "ticketing"."task_number_values" (
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"value" numeric(38, 18),
	CONSTRAINT "ticketing_task_number_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_number_values_revision_ck" CHECK ("ticketing"."task_number_values"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD COLUMN "number_format" text;--> statement-breakpoint
ALTER TABLE "ticketing"."task_number_values" ADD CONSTRAINT "task_number_values_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_number_values" ADD CONSTRAINT "task_number_values_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_number_values" ADD CONSTRAINT "task_number_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticketing_task_number_values_query_idx" ON "ticketing"."task_number_values" USING btree ("tenant_id","property_definition_id","value");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_number_format_ck" CHECK (("ticketing"."task_property_definitions"."datatype" = 'number' and "ticketing"."task_property_definitions"."number_format" in ('number', 'number_with_separators', 'percent')) or ("ticketing"."task_property_definitions"."datatype" <> 'number' and "ticketing"."task_property_definitions"."number_format" is null));--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'number'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'checkbox_value_changed', 'number_value_changed', 'archived', 'restored', 'soft_deleted'));
