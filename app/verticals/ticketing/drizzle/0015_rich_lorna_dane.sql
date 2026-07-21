CREATE TABLE "ticketing"."task_person_assignments" (
	"principal_id" uuid NOT NULL,
	"property_definition_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_person_assignments_pk" PRIMARY KEY("task_id","property_definition_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_person_property_configurations" (
	"cardinality" text DEFAULT 'unlimited' NOT NULL,
	"property_definition_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_person_property_configurations_cardinality_ck" CHECK ("ticketing"."task_person_property_configurations"."cardinality" in ('one', 'unlimited'))
);
--> statement-breakpoint
CREATE TABLE "ticketing"."task_person_values" (
	"property_definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "ticketing_task_person_values_pk" PRIMARY KEY("task_id","property_definition_id"),
	CONSTRAINT "ticketing_task_person_values_revision_ck" CHECK ("ticketing"."task_person_values"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" DROP CONSTRAINT "ticketing_task_property_definitions_datatype_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" DROP CONSTRAINT "ticketing_task_revisions_reason_ck";--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_assignments" ADD CONSTRAINT "task_person_assignments_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "core"."principals"("principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_assignments" ADD CONSTRAINT "task_person_assignments_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_assignments" ADD CONSTRAINT "task_person_assignments_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_assignments" ADD CONSTRAINT "task_person_assignments_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_property_configurations" ADD CONSTRAINT "task_person_property_configurations_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_property_configurations" ADD CONSTRAINT "task_person_property_configurations_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_values" ADD CONSTRAINT "task_person_values_property_definition_id_task_property_definitions_property_definition_id_fk" FOREIGN KEY ("property_definition_id") REFERENCES "ticketing"."task_property_definitions"("property_definition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_values" ADD CONSTRAINT "task_person_values_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "ticketing"."tasks"("task_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticketing"."task_person_values" ADD CONSTRAINT "task_person_values_tenant_id_tenants_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticketing_task_person_assignments_membership_idx" ON "ticketing"."task_person_assignments" USING btree ("tenant_id","property_definition_id","principal_id");--> statement-breakpoint
CREATE INDEX "ticketing_task_person_property_configurations_tenant_idx" ON "ticketing"."task_person_property_configurations" USING btree ("tenant_id","property_definition_id");--> statement-breakpoint
CREATE INDEX "ticketing_task_person_values_definition_idx" ON "ticketing"."task_person_values" USING btree ("tenant_id","property_definition_id");--> statement-breakpoint
ALTER TABLE "ticketing"."task_property_definitions" ADD CONSTRAINT "ticketing_task_property_definitions_datatype_ck" CHECK ("ticketing"."task_property_definitions"."datatype" in ('title', 'checkbox', 'created_time', 'created_by', 'email', 'number', 'person', 'phone', 'select', 'text', 'url'));--> statement-breakpoint
ALTER TABLE "ticketing"."task_revisions" ADD CONSTRAINT "ticketing_task_revisions_reason_ck" CHECK ("ticketing"."task_revisions"."reason" in ('created', 'checkbox_value_changed', 'email_value_changed', 'number_value_changed', 'person_value_changed', 'phone_value_changed', 'select_value_changed', 'text_value_changed', 'url_value_changed', 'archived', 'restored', 'soft_deleted'));