CREATE TABLE "ticketing"."task_email_values" (
	"normalized_value" text NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "ticketing_task_email_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_email_values_revision_ck" CHECK ("ticketing"."task_email_values"."revision" >= 1),
	CONSTRAINT "ticketing_task_email_values_trimmed_ck" CHECK (btrim("ticketing"."task_email_values"."value") = "ticketing"."task_email_values"."value"),
	CONSTRAINT "ticketing_task_email_values_normalized_ck" CHECK ("ticketing"."task_email_values"."normalized_value" = lower("ticketing"."task_email_values"."value")),
	CONSTRAINT "ticketing_task_email_values_length_ck" CHECK (char_length("ticketing"."task_email_values"."value") between 1 and 254)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_email_values" ADD CONSTRAINT "task_email_values_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_email_values" ADD CONSTRAINT "task_email_values_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_email_values" ADD CONSTRAINT "task_email_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticketing_task_email_values_query_idx" ON "ticketing"."task_email_values" USING btree ("tenant_id","property_definition_id","normalized_value","task_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'email'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'checkbox_value_changed', 'email_value_changed', 'archived', 'restored', 'soft_deleted'));