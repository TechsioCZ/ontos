CREATE TABLE "ticketing"."task_date_values" (
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"value" date,
	CONSTRAINT "ticketing_task_date_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_date_values_revision_ck" CHECK ("ticketing"."task_date_values"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_date_values" ADD CONSTRAINT "task_date_values_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_date_values" ADD CONSTRAINT "task_date_values_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_date_values" ADD CONSTRAINT "task_date_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticketing_task_date_values_group_idx" ON "ticketing"."task_date_values" USING btree ("tenant_id","property_definition_id","value");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'date', 'email', 'number', 'phone', 'select', 'text', 'url'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'checkbox_value_changed', 'date_value_changed', 'email_value_changed', 'number_value_changed', 'phone_value_changed', 'select_value_changed', 'text_value_changed', 'url_value_changed', 'archived', 'restored', 'soft_deleted'));
